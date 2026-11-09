import json

import pandas as pd

from simple_etl import create_app
from simple_etl.services.connection_manager import ConnectionManager
from simple_etl.services.external_sources import ExternalSourceService


class _MemoryKeyring:
    class errors:
        class PasswordDeleteError(Exception):
            pass

    def __init__(self):
        self.values = {}

    def get_password(self, service, username):
        return self.values.get((service, username))

    def set_password(self, service, username, password):
        self.values[(service, username)] = password

    def delete_password(self, service, username):
        self.values.pop((service, username), None)


def _app(tmp_path):
    return create_app({
        "TESTING": True,
        "STORAGE_ROOT": tmp_path / "storage",
        "CONNECTIONS_API_TOKEN": "test-access-token",
    })


def _auth():
    return {"Authorization": "Bearer test-access-token"}


def test_connections_require_access_token_and_do_not_return_secrets(tmp_path, monkeypatch):
    keyring = _MemoryKeyring()
    monkeypatch.setattr(ConnectionManager, "_keyring", staticmethod(lambda: keyring))
    app = _app(tmp_path)
    client = app.test_client()
    payload = {
        "kind": "mysql",
        "name": "Private test database",
        "host": "127.0.0.1",
        "port": 3306,
        "database": "etl_test",
        "username": "reader",
        "password": "never-return-this",
        "allow_private_network": True,
    }

    assert client.get("/api/connections").status_code == 401
    created = client.post("/api/connections", json=payload, headers=_auth())
    assert created.status_code == 201, created.json
    assert "password" not in created.json
    assert "never-return-this" not in json.dumps(created.json)

    listed = client.get("/api/connections", headers=_auth())
    assert listed.status_code == 200
    assert listed.json[0]["secret_configured"] is True
    assert "never-return-this" not in json.dumps(listed.json)
    stored = app.extensions["etl_storage"].read_json(
        app.extensions["etl_storage"].metadata_dir / "connections.json", [],
    )
    assert "never-return-this" not in json.dumps(stored)


def test_api_bearer_token_is_kept_out_of_connection_metadata_and_responses(tmp_path, monkeypatch):
    keyring = _MemoryKeyring()
    monkeypatch.setattr(ConnectionManager, "_keyring", staticmethod(lambda: keyring))
    monkeypatch.setattr(
        "simple_etl.services.connection_manager.validate_api_url",
        lambda value, **_kwargs: value,
    )
    app = _app(tmp_path)
    client = app.test_client()
    token = "private-api-bearer-token"

    created = client.post("/api/connections", json={
        "kind": "api",
        "name": "Exchange rates",
        "api_url": "https://api.example.com/rates",
        "auth_type": "bearer",
        "token": token,
    }, headers=_auth())

    assert created.status_code == 201, created.json
    stored = app.extensions["etl_storage"].read_json(
        app.extensions["etl_storage"].metadata_dir / "connections.json", [],
    )
    assert token not in json.dumps(created.json)
    assert token not in json.dumps(stored)
    connection, secrets = ConnectionManager(app.extensions["etl_storage"]).get_with_secrets(created.json["connection_id"])
    assert ExternalSourceService._api_headers(connection, secrets)["Authorization"] == f"Bearer {token}"


def test_external_input_executes_only_when_connected_and_preserves_node_preview(tmp_path, monkeypatch):
    keyring = _MemoryKeyring()
    monkeypatch.setattr(ConnectionManager, "_keyring", staticmethod(lambda: keyring))
    app = _app(tmp_path)
    client = app.test_client()
    created = client.post("/api/connections", json={
        "kind": "mysql",
        "name": "Read-only sales",
        "host": "127.0.0.1",
        "database": "sales",
        "username": "etl_reader",
        "password": "db-secret",
        "allow_private_network": True,
    }, headers=_auth()).json
    calls = []

    def fake_extract(self, connection, secrets, config, row_limit):
        calls.append((connection["connection_id"], secrets["password"], config["table"], row_limit))
        return pd.DataFrame({"region": ["North", "South"], "amount": [4, 8]}), {"row_count": 2, "column_count": 2}

    monkeypatch.setattr(ExternalSourceService, "extract", fake_extract)
    workflow = client.post("/api/workflows", json={
        "name": "External sales read",
        "nodes": [
            {"id": "source", "type": "mysql_input", "name": "Sales", "config": {"connection_id": created["connection_id"], "table": "orders"}},
            {"id": "filter", "type": "filter_rows", "name": "North", "config": {"column": "region", "operator": "equals", "value": "North"}},
            {"id": "output", "type": "json_output", "name": "JSON", "config": {"filename": "sales"}},
        ],
        "edges": [
            {"id": "source-filter", "source": "source", "target": "filter"},
            {"id": "filter-output", "source": "filter", "target": "output"},
        ],
    }).json

    result = client.post(f"/api/workflows/{workflow['workflow_id']}/execute")
    assert result.status_code == 200, result.json
    assert result.json["summary"]["input_rows"] == 2
    assert result.json["summary"]["output_datasets"] == ["sales.json"]
    assert result.json["node_statuses"]["source"]["source_metrics"]["row_count"] == 2
    preview = client.get(f"/api/workflows/{workflow['workflow_id']}/nodes/filter/preview").json
    assert preview["rows"] == [["North", 4]]
    saved = client.get(f"/api/workflows/{workflow['workflow_id']}").json
    assert "db-secret" not in json.dumps(saved)
    assert calls and all(call[1] == "db-secret" for call in calls)


def test_workflow_rejects_raw_connection_secrets(tmp_path):
    client = _app(tmp_path).test_client()
    response = client.post("/api/workflows", json={
        "name": "Unsafe workflow",
        "nodes": [{"id": "source", "type": "api_input", "name": "API", "config": {"connection_id": "a" * 32, "token": "secret"}}],
        "edges": [],
    })
    assert response.status_code == 400
    assert "secrets" in response.json["error"]


class _ApiResponse:
    def __init__(self, body, content_type="application/json"):
        self.body = body.encode("utf-8")
        self.headers = {"Content-Type": content_type}
        self.status_code = 200
        self.ok = True

    def iter_content(self, chunk_size):
        assert chunk_size > 0
        yield self.body

    def close(self):
        pass


class _ApiSession:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []
        self.trust_env = True

    def get(self, url, params, **_kwargs):
        self.calls.append((url, params))
        return self.responses[len(self.calls) - 1]

    def close(self):
        pass


def test_api_extracts_nested_json_with_bounded_page_number_pagination(monkeypatch):
    session = _ApiSession([
        _ApiResponse('{"data":{"results":[{"id":1},{"id":2}]}}'),
        _ApiResponse('{"data":{"results":[{"id":3}]}}'),
    ])
    monkeypatch.setattr("simple_etl.services.external_sources.requests.Session", lambda: session)
    monkeypatch.setattr("simple_etl.services.external_sources.validate_api_url", lambda *args, **_kwargs: args[0])
    connection = {
        "api_url": "https://api.example.com/records",
        "method": "GET",
        "timeout": 5,
        "query_params": {},
        "headers": {},
        "auth_type": "none",
        "allow_private_network": False,
    }

    frame, metrics = ExternalSourceService().extract_api(connection, {}, {
        "data_path": "data.results",
        "field_mapping": {"id": "record_id"},
        "pagination": {"mode": "page", "page_size": 2, "max_pages": 4},
    })

    assert frame.to_dict(orient="records") == [{"record_id": 1}, {"record_id": 2}, {"record_id": 3}]
    assert metrics["pages_fetched"] == 2
    assert session.calls[0][1]["page"] == 1
    assert session.calls[1][1]["page"] == 2
    assert session.trust_env is False


def test_api_extracts_csv_and_maps_columns(monkeypatch):
    session = _ApiSession([_ApiResponse("sku,price\nA,2\nB,4\n", "text/csv")])
    monkeypatch.setattr("simple_etl.services.external_sources.requests.Session", lambda: session)
    monkeypatch.setattr("simple_etl.services.external_sources.validate_api_url", lambda *args, **_kwargs: args[0])
    connection = {
        "api_url": "https://api.example.com/export",
        "timeout": 5,
        "query_params": {},
        "headers": {},
        "auth_type": "none",
        "allow_private_network": False,
    }

    frame, metrics = ExternalSourceService().extract_api(connection, {}, {
        "response_format": "auto",
        "field_mapping": {"sku": "item"},
    })

    assert frame.to_dict(orient="records") == [{"item": "A", "price": 2}, {"item": "B", "price": 4}]
    assert metrics["http_status"] == 200
    assert metrics["pages_fetched"] == 1