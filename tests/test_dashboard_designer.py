import io
import json
import re

from simple_etl import create_app


def _client(tmp_path):
    app = create_app({
        "TESTING": True,
        "DEBUG": False,
        "STORAGE_ROOT": tmp_path / "storage",
        "MAX_UPLOAD_SIZE_MB": 2,
    })
    return app.test_client(), app.extensions["etl_storage"]


def _upload(client, name, content):
    response = client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(content), name)},
        content_type="multipart/form-data",
    )
    assert response.status_code == 201, response.json
    return response.json


def test_dashboard_crud_persists_file_backed_json_and_validates_input(tmp_path):
    client, storage = _client(tmp_path)
    invalid_payloads = [
        [],
        {},
        {"name": "  "},
        {"name": "x" * 121},
        {"name": "Valid", "dashboard_id": "a" * 32},
        {"name": "Valid", "widgets": {}},
        {"name": "Valid", "widgets": [None] * 101},
    ]
    for payload in invalid_payloads:
        assert client.post("/api/dashboards", json=payload).status_code == 400

    created = client.post("/api/dashboards", json={
        "name": "  Sales overview  ",
        "widgets": [{"type": "table", "dataset_id": "a" * 32}],
        "layout": {"columns": 2},
        "components": [{
            "id": "chart-a",
            "type": "bar",
            "position": {"x": 6, "y": 420},
            "width": 4,
            "height": 250,
            "z_index": 3,
            "layout_section": "sales",
            "config": {"measure": "amount"},
        }],
    })
    assert created.status_code == 201, created.json
    dashboard = created.json
    dashboard_id = dashboard["dashboard_id"]
    assert re.fullmatch(r"[a-f0-9]{32}", dashboard_id)
    assert dashboard["name"] == "Sales overview"
    assert dashboard["components"][0]["position"] == {"x": 6, "y": 420}
    assert dashboard["components"][0]["z_index"] == 3
    assert json.loads(storage.dashboard_path(dashboard_id).read_text(encoding="utf-8")) == dashboard

    fetched = client.get(f"/api/dashboards/{dashboard_id}")
    assert fetched.status_code == 200
    assert fetched.json == dashboard
    listed = client.get("/api/dashboards")
    assert listed.status_code == 200
    assert [item["dashboard_id"] for item in listed.json] == [dashboard_id]

    updated = client.put(f"/api/dashboards/{dashboard_id}", json={
        "name": "Updated dashboard",
        "widgets": [],
    })
    assert updated.status_code == 200
    assert updated.json["dashboard_id"] == dashboard_id
    assert updated.json["created_at"] == dashboard["created_at"]
    assert updated.json["name"] == "Updated dashboard"

    assert client.delete("/api/dashboards/not-a-safe-id").status_code == 400
    deleted = client.delete(f"/api/dashboards/{dashboard_id}")
    assert deleted.status_code == 200
    assert not storage.dashboard_path(dashboard_id).exists()
    assert client.get(f"/api/dashboards/{dashboard_id}").status_code == 404


def test_dashboard_payload_and_ids_are_bounded_and_safe(tmp_path):
    client, _storage = _client(tmp_path)
    too_large = {"name": "Large", "description": "x" * 1_000_001}
    assert client.post("/api/dashboards", json=too_large).status_code == 400
    assert client.get("/api/dashboards/../outside").status_code in {400, 404}

    uploaded = _upload(client, "metrics.csv", b"category,value\nA,1\nB,2\n")
    assert client.get(f"/api/datasets/{uploaded['file_id']}/schema").status_code == 200

    assert client.get("/api/datasets/not-a-safe-id/schema").status_code == 400
    assert client.get("/api/datasets/not-a-safe-id/preview").status_code == 400


def test_dataset_discovery_schema_and_preview_include_uploaded_and_processed(tmp_path):
    client, _storage = _client(tmp_path)
    uploaded = _upload(client, "metrics.csv", b"category,value\nA,1\nB,2\n")
    processed_response = client.post(
        f"/api/files/{uploaded['file_id']}/clean",
        json={"operation": "trim_text", "column": "category"},
    )
    assert processed_response.status_code == 201, processed_response.json
    processed = processed_response.json["dataset"]

    discovery = client.get("/api/datasets")
    assert discovery.status_code == 200
    datasets = {record["file_id"]: record for record in discovery.json}
    assert datasets[uploaded["file_id"]]["status"] == "uploaded"
    assert datasets[processed["file_id"]]["status"] == "processed"
    assert datasets[uploaded["file_id"]]["rows"] == 2
    assert datasets[uploaded["file_id"]]["column_count"] == 2

    for record in (uploaded, processed):
        schema = client.get(f"/api/datasets/{record['file_id']}/schema")
        assert schema.status_code == 200, schema.json
        assert schema.json["rows"] == 2
        assert schema.json["numeric_columns"] == ["value"]
        assert schema.json["text_columns"] == ["category"]
        assert [column["name"] for column in schema.json["schema"]] == ["category", "value"]
        assert all({"name", "kind", "dtype"} <= set(column) for column in schema.json["schema"])
        preview = client.get(f"/api/datasets/{record['file_id']}/preview?page=2&page_size=1")
        assert preview.status_code == 200, preview.json
        assert preview.json["rows"] == [["B", 2]]
        assert preview.json["total_rows"] == 2
        assert preview.json["page"] == 2

    assert client.get(f"/api/datasets/{'f' * 32}/schema").status_code == 404
    assert client.get(f"/api/datasets/{uploaded['file_id']}/preview?page=0").status_code == 400
