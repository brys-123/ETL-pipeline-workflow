import io
import json

import pytest
from openpyxl import Workbook

from simple_etl import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app({
        "TESTING": True,
        "DEBUG": False,
        "STORAGE_ROOT": tmp_path / "storage",
        "MAX_UPLOAD_SIZE_MB": 1,
    })
    return app.test_client(), app.extensions["etl_storage"]


def test_health_and_storage_directories(client):
    test_client, storage = client
    response = test_client.get("/api/health")
    assert response.status_code == 200
    assert response.json["storage_available"] is True
    settings = json.loads((storage.metadata_dir / "settings.json").read_text(encoding="utf-8"))
    assert settings["storage_mode"] == "local"
    assert settings["max_upload_size_mb"] == 1
    for path in (storage.uploads_dir, storage.processed_dir, storage.workflows_dir, storage.logs_dir, storage.metadata_dir):
        assert path.is_dir()


def test_flask_serves_frontend_shell_and_assets(client):
    test_client, _storage = client
    page = test_client.get("/")
    script = test_client.get("/js/app.js")
    stylesheet = test_client.get("/css/style.css")
    assert page.status_code == 200
    assert b"Simple ETL Studio" in page.data
    assert script.status_code == 200
    assert stylesheet.status_code == 200


def test_upload_metadata_dashboard_and_safe_delete(client):
    test_client, storage = client
    response = test_client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(b"region,sales\nNorth,12\n"), "sales.csv")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 201
    record = response.json
    assert record["filename"] == "sales.csv"
    assert record["file_type"] == "csv"
    assert (storage.uploads_dir / record["stored_name"]).is_file()
    assert test_client.get("/api/files").json == [record]
    assert test_client.get("/api/dashboard/stats").json["total_uploaded_files"] == 1

    deleted = test_client.delete(f"/api/files/{record['file_id']}")
    assert deleted.status_code == 200
    assert test_client.get("/api/files").json == []
    assert not (storage.uploads_dir / record["stored_name"]).exists()


def test_rejects_unsupported_and_invalid_datasets(client):
    test_client, _storage = client
    unsupported = test_client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(b"not allowed"), "notes.txt")},
        content_type="multipart/form-data",
    )
    assert unsupported.status_code == 400

    invalid_json = test_client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(b"{broken"), "bad.json")},
        content_type="multipart/form-data",
    )
    assert invalid_json.status_code == 400

    invalid_excel = test_client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(b"not an excel workbook"), "bad.xlsx")},
        content_type="multipart/form-data",
    )
    assert invalid_excel.status_code == 400


def test_rejects_uploads_over_configured_limit(client):
    test_client, _storage = client
    oversized = test_client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(b"x" * (1024 * 1024 + 1)), "large.csv")},
        content_type="multipart/form-data",
    )
    assert oversized.status_code == 413


def test_accepts_valid_json_and_xlsx_datasets(client):
    test_client, storage = client
    json_response = test_client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(b'[{"region":"North"}]'), "regions.json")},
        content_type="multipart/form-data",
    )
    workbook_stream = io.BytesIO()
    workbook = Workbook()
    workbook.active.append(["region", "sales"])
    workbook.active.append(["North", 12])
    workbook.save(workbook_stream)
    xlsx_response = test_client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(workbook_stream.getvalue()), "regions.xlsx")},
        content_type="multipart/form-data",
    )

    assert json_response.status_code == 201
    assert xlsx_response.status_code == 201
    assert (storage.uploads_dir / json_response.json["stored_name"]).is_file()
    assert (storage.uploads_dir / xlsx_response.json["stored_name"]).is_file()


def test_workflow_json_can_be_created_loaded_listed_and_deleted(client):
    test_client, storage = client
    payload = {
        "name": "Sales cleanup",
        "nodes": [
            {"id": "source-1", "type": "csv_input", "name": "Sales CSV", "position": {"x": 120, "y": 90}, "config": {}},
            {"id": "clean-1", "type": "clean_data", "name": "Clean data", "position": {"x": 360, "y": 90}, "config": {}},
        ],
        "edges": [{"id": "edge-1", "source": "source-1", "target": "clean-1"}],
    }
    created = test_client.post("/api/workflows", json=payload)
    assert created.status_code == 201
    workflow = created.json
    assert workflow["workflow_id"]
    assert json.loads((storage.workflows_dir / f"{workflow['workflow_id']}.json").read_text(encoding="utf-8")) == workflow
    assert test_client.get(f"/api/workflows/{workflow['workflow_id']}").json == workflow
    assert test_client.get("/api/workflows").json == [workflow]

    updated = test_client.post("/api/workflows", json={**payload, "workflow_id": workflow["workflow_id"], "name": "Sales cleanup v2"})
    assert updated.status_code == 200
    assert updated.json["created_at"] == workflow["created_at"]
    assert updated.json["name"] == "Sales cleanup v2"

    deleted = test_client.delete(f"/api/workflows/{workflow['workflow_id']}")
    assert deleted.status_code == 200
    assert test_client.get(f"/api/workflows/{workflow['workflow_id']}").status_code == 404


def test_rejects_edges_to_unknown_nodes_and_traversal_ids(client):
    test_client, _storage = client
    response = test_client.post("/api/workflows", json={
        "name": "Invalid graph",
        "nodes": [{"id": "source", "type": "csv_input"}],
        "edges": [{"source": "source", "target": "missing"}],
    })
    assert response.status_code == 400
    assert test_client.delete("/api/files/../metadata/files.json").status_code == 404