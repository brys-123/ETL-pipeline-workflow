import io

import pytest
from flask import g
from werkzeug.security import check_password_hash

from simple_etl import create_app
from simple_etl.services.auth_service import AuthService
from simple_etl.services.metadata_service import MetadataService


PASSWORD = "Strongpass1234"


@pytest.fixture
def auth_app(tmp_path):
    app = create_app({
        "TESTING": True,
        "AUTH_ENABLED": True,
        "DEBUG": False,
        "SECRET_KEY": "test-auth-secret-key",
        "STORAGE_ROOT": tmp_path / "storage",
        "MAX_UPLOAD_SIZE_MB": 1,
    })
    return app, app.test_client()


def csrf(client):
    response = client.get("/api/auth/status")
    assert response.status_code == 200
    return client.get_cookie("simple_etl_csrf").value


def register(client, *, username="sample_user", email="sample@example.com", password=PASSWORD):
    token = csrf(client)
    return client.post(
        "/api/auth/register",
        json={
            "full_name": "Sample User",
            "username": username,
            "email": email,
            "password": password,
            "confirm_password": password,
        },
        headers={"X-CSRF-Token": token},
    )


def test_unauthenticated_application_and_api_are_protected(auth_app):
    _app, client = auth_app
    assert client.get("/").status_code == 302
    assert client.get("/login").status_code == 200
    assert client.get("/api/files").status_code == 401
    assert client.get("/api/auth/me").status_code == 401


def test_registration_hashes_password_and_restores_session(auth_app):
    app, client = auth_app
    response = register(client)
    assert response.status_code == 200
    assert response.json["authenticated"] is True
    assert response.json["user"]["role"] == "user"
    assert response.json["user"]["last_login_at"] is not None
    assert "password_hash" not in response.json["user"]
    assert client.get("/").status_code == 200
    assert client.get("/api/auth/status").json["authenticated"] is True

    users_file = app.extensions["etl_storage"].root / "auth" / "users.json"
    user = users_file.read_text(encoding="utf-8")
    import json

    record = json.loads(user)[0]
    assert record["password_hash"].startswith("scrypt:")
    assert check_password_hash(record["password_hash"], PASSWORD)
    assert PASSWORD not in user
    duplicate = register(client, email="sample@example.com")
    assert duplicate.status_code == 409


def test_login_logout_csrf_and_remember_session(auth_app):
    app, client = auth_app
    assert register(client).status_code == 200
    csrf_token = client.get_cookie("simple_etl_csrf").value
    assert client.post("/api/auth/logout", json={}, headers={"X-CSRF-Token": "invalid"}).status_code == 400
    logout = client.post("/api/auth/logout", json={}, headers={"X-CSRF-Token": csrf_token})
    assert logout.status_code == 200
    assert client.get("/api/files").status_code == 401

    csrf_token = csrf(client)
    login = client.post(
        "/api/auth/login",
        json={"identity": "sample@example.com", "password": PASSWORD, "remember": True},
        headers={"X-CSRF-Token": csrf_token},
    )
    assert login.status_code == 200
    session_cookie = client.get_cookie("simple_etl_session")
    assert session_cookie is not None
    assert session_cookie.max_age == 30 * 24 * 60 * 60
    session_store = app.extensions["etl_storage"].root / "auth" / "sessions.json"
    assert session_cookie.value not in session_store.read_text(encoding="utf-8")

    client.post(
        "/api/auth/logout",
        json={},
        headers={"X-CSRF-Token": client.get_cookie("simple_etl_csrf").value},
    )
    assert client.get("/api/auth/status").json["authenticated"] is False


def test_password_validation_and_csrf_protect_registration(auth_app):
    _app, client = auth_app
    bad_csrf = client.post(
        "/api/auth/register",
        json={
            "full_name": "Sample User",
            "username": "sample_user",
            "email": "sample@example.com",
            "password": PASSWORD,
            "confirm_password": PASSWORD,
        },
    )
    assert bad_csrf.status_code == 400
    assert register(client, password="weak").status_code == 400
    assert register(client).status_code == 200
    duplicate_username = register(client, username="sample_user", email="other@example.com")
    assert duplicate_username.status_code == 409


def test_users_cannot_read_or_delete_each_others_uploaded_data(auth_app):
    app, client_a = auth_app
    client_b = app.test_client()
    assert register(client_a, username="owner_a", email="a@example.com").status_code == 200
    token_a = client_a.get_cookie("simple_etl_csrf").value
    uploaded = client_a.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(b"region,sales\nNorth,12\n"), "sales.csv")},
        content_type="multipart/form-data",
        headers={"X-CSRF-Token": token_a},
    )
    assert uploaded.status_code == 201
    file_id = uploaded.json["file_id"]

    assert register(client_b, username="owner_b", email="b@example.com").status_code == 200
    assert client_b.get("/api/files").json == []
    assert client_b.get(f"/api/files/{file_id}/preview").status_code == 404
    response = client_b.delete(f"/api/files/{file_id}", headers={
        "X-CSRF-Token": client_b.get_cookie("simple_etl_csrf").value,
    })
    assert response.status_code == 404
    assert client_a.get("/api/files").json[0]["file_id"] == file_id


def test_users_cannot_read_or_delete_each_others_workflows_dashboards_or_executions(auth_app):
    app, client_a = auth_app
    client_b = app.test_client()
    assert register(client_a, username="owner_a", email="a@example.com").status_code == 200
    csrf_a = client_a.get_cookie("simple_etl_csrf").value
    workflow = client_a.post(
        "/api/workflows",
        json={"name": "Private workflow", "nodes": [], "edges": []},
        headers={"X-CSRF-Token": csrf_a},
    )
    dashboard = client_a.post(
        "/api/dashboards",
        json={"name": "Private dashboard", "widgets": []},
        headers={"X-CSRF-Token": csrf_a},
    )
    assert workflow.status_code == 201
    assert dashboard.status_code == 201

    user_a = client_a.get("/api/auth/me").json["user"]
    with app.test_request_context("/api/executions"):
        g.current_user = user_a
        MetadataService(app.extensions["etl_storage"]).save_execution({
            "execution_id": "a" * 32,
            "workflow_id": workflow.json["workflow_id"],
            "status": "completed",
        })

    assert register(client_b, username="owner_b", email="b@example.com").status_code == 200
    assert client_b.get("/api/workflows").json == []
    assert client_b.get(f"/api/workflows/{workflow.json['workflow_id']}").status_code == 404
    assert client_b.delete(
        f"/api/workflows/{workflow.json['workflow_id']}",
        headers={"X-CSRF-Token": client_b.get_cookie("simple_etl_csrf").value},
    ).status_code == 404
    assert client_b.get("/api/dashboards").json == []
    assert client_b.get(f"/api/dashboards/{dashboard.json['dashboard_id']}").status_code == 404
    assert client_b.get("/api/executions").json == []
    assert client_b.get(f"/api/executions/{'a' * 32}").status_code == 404


def test_profile_picture_is_private_validated_and_served(auth_app):
    _app, client = auth_app
    assert register(client).status_code == 200
    picture = b"\x89PNG\r\n\x1a\n" + b"test-image"
    response = client.post(
        "/api/auth/profile-picture",
        data={"picture": (io.BytesIO(picture), "avatar.png")},
        content_type="multipart/form-data",
        headers={"X-CSRF-Token": client.get_cookie("simple_etl_csrf").value},
    )
    assert response.status_code == 200
    assert response.json["user"]["profile_picture"] == "/api/auth/profile-picture/png"
    downloaded = client.get(response.json["user"]["profile_picture"])
    assert downloaded.status_code == 200
    assert downloaded.mimetype == "image/png"
    assert downloaded.data == picture
    assert client.get("/api/auth/profile-picture/unknown").status_code == 404

    other_client = _app.test_client()
    assert register(other_client, username="other_user", email="other@example.com").status_code == 200
    assert other_client.get("/api/auth/profile-picture/png").status_code == 404


def test_profile_change_and_password_change_revoke_other_sessions(auth_app):
    app, client_a = auth_app
    client_b = app.test_client()
    assert register(client_a).status_code == 200
    assert client_b.get("/api/auth/status").status_code == 200
    login = client_b.post(
        "/api/auth/login",
        json={"identity": "sample_user", "password": PASSWORD, "remember": False},
        headers={"X-CSRF-Token": client_b.get_cookie("simple_etl_csrf").value},
    )
    assert login.status_code == 200

    profile = client_a.patch(
        "/api/auth/profile",
        json={"full_name": "Updated Name", "username": "sample_user", "email": "updated@example.com"},
        headers={"X-CSRF-Token": client_a.get_cookie("simple_etl_csrf").value},
    )
    assert profile.status_code == 200
    password_change = client_a.post(
        "/api/auth/password",
        json={
            "current_password": PASSWORD,
            "password": "AnotherStrong123",
            "confirm_password": "AnotherStrong123",
        },
        headers={"X-CSRF-Token": client_a.get_cookie("simple_etl_csrf").value},
    )
    assert password_change.status_code == 200
    assert client_b.get("/api/auth/me").status_code == 401
    assert client_a.get("/api/auth/me").json["user"]["full_name"] == "Updated Name"


def test_admin_routes_require_admin_and_return_only_public_user_fields(auth_app):
    app, user_client = auth_app
    assert register(user_client).status_code == 200
    assert user_client.get("/api/admin/users").status_code == 403

    admin = AuthService(app.extensions["etl_storage"]).create_user(
        full_name="Studio Admin",
        username="studio_admin",
        email="admin@example.com",
        password=PASSWORD,
        role="admin",
    )
    admin_client = app.test_client()
    admin_token = csrf(admin_client)
    login = admin_client.post(
        "/api/auth/login",
        json={"identity": admin["username"], "password": PASSWORD},
        headers={"X-CSRF-Token": admin_token},
    )
    assert login.status_code == 200
    users = admin_client.get("/api/admin/users")
    assert users.status_code == 200
    assert all("password_hash" not in user for user in users.json["users"])
    assert admin_client.get("/api/admin/sessions").status_code == 200
    assert admin_client.get("/api/admin/activity").status_code == 200
