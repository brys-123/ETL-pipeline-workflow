import io

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


def test_cleaning_preview_sequentially_applies_operations_without_writing_files(tmp_path):
    client, storage = _client(tmp_path)
    original_bytes = b"id,name,age,unused\n1, John ,25,x\n2,Mary,,x\n2,Mary,,x\n3,Peter,28,y\n"
    source = _upload(client, "dirty.csv", original_bytes)
    source_path = storage.uploads_dir / source["stored_name"]
    operations = [
        {"operation": "trim_text", "column": "name"},
        {"operation": "remove_columns", "columns": ["unused"]},
        {"operation": "remove_duplicates"},
        {"operation": "fill_missing", "columns": ["age"], "method": "constant", "value": "0"},
        {"operation": "filter_rows", "column": "age", "operator": "greater_than", "value": "20"},
        {"operation": "rename_column", "from": "name", "to": "person"},
    ]

    before = client.post(
        f"/api/files/{source['file_id']}/clean/preview",
        json={"operations": operations, "step": -1},
    )
    assert before.status_code == 200, before.json
    assert before.json["before"]["columns"] == ["id", "name", "age", "unused"]
    assert before.json["after"]["rows"] == before.json["before"]["rows"]

    deduplicated = client.post(
        f"/api/files/{source['file_id']}/clean/preview",
        json={"operations": operations, "step": 2},
    )
    assert deduplicated.status_code == 200, deduplicated.json
    assert deduplicated.json["after_stats"]["rows"] == 3
    assert deduplicated.json["after"]["columns"] == ["id", "name", "age"]
    assert deduplicated.json["stages"][2]["duplicate_rows"] == 0

    preview = client.post(
        f"/api/files/{source['file_id']}/clean/preview",
        json={"operations": operations, "step": 5},
    )
    assert preview.status_code == 200, preview.json
    assert preview.json["after"]["columns"] == ["id", "person", "age"]
    assert preview.json["after"]["rows"] == [["1", "John", "25.0"], ["3", "Peter", "28.0"]]

    changed_filter = [*operations[:-2], {**operations[-2], "value": "26"}, operations[-1]]
    changed = client.post(
        f"/api/files/{source['file_id']}/clean/preview",
        json={"operations": changed_filter},
    )
    assert changed.status_code == 200, changed.json
    assert changed.json["after"]["rows"] == [["3", "Peter", "28.0"]]

    assert source_path.read_bytes() == original_bytes
    assert client.get("/api/files?status=processed").json == []
    assert list(storage.processed_dir.iterdir()) == []


def test_cleaning_preview_handles_missing_values_empty_results_and_invalid_operations(tmp_path):
    client, _storage = _client(tmp_path)
    source = _upload(client, "missing.csv", b"name,value\nA,\nB,2\n")

    filled = client.post(
        f"/api/files/{source['file_id']}/clean/preview",
        json={"operations": [{"operation": "fill_missing", "columns": ["value"], "value": "9"}]},
    )
    assert filled.status_code == 200, filled.json
    assert filled.json["after"]["rows"] == [["A", "9.0"], ["B", "2.0"]]

    empty = client.post(
        f"/api/files/{source['file_id']}/clean/preview",
        json={"operations": [{"operation": "filter_rows", "column": "name", "operator": "equals", "value": "missing"}]},
    )
    assert empty.status_code == 200, empty.json
    assert empty.json["after_stats"]["rows"] == 0
    assert empty.json["after"]["rows"] == []

    failed = client.post(
        f"/api/files/{source['file_id']}/clean/preview",
        json={"operations": [{"operation": "filter_rows", "column": "not_a_column", "operator": "equals", "value": "A"}]},
    )
    assert failed.status_code == 400
    assert "column" in failed.json["error"].lower()

    too_many_rows = client.post(
        f"/api/files/{source['file_id']}/clean/preview",
        json={"operations": [], "page_size": 51},
    )
    assert too_many_rows.status_code == 400


def test_cleaning_preview_matches_workflow_execution_and_saved_copy(tmp_path):
    client, storage = _client(tmp_path)
    source = _upload(client, "people.csv", b"name,age\n Alice ,20\nBob,30\nBob,30\nCara,40\n")
    operations = [
        {"operation": "trim_text", "column": "name"},
        {"operation": "remove_duplicates"},
        {"operation": "filter_rows", "column": "age", "operator": "greater_than", "value": "20"},
        {"operation": "rename_column", "from": "name", "to": "person"},
    ]
    preview = client.post(
        f"/api/files/{source['file_id']}/clean/preview",
        json={"operations": operations},
    )
    assert preview.status_code == 200, preview.json

    workflow_nodes = [
        {"id": "input", "type": "csv_input", "name": "People", "config": {"file_id": source["file_id"]}},
        {"id": "trim", "type": "clean_data", "name": "Trim names", "config": operations[0]},
        {"id": "duplicates", "type": "remove_duplicates", "name": "Remove duplicates", "config": operations[1]},
        {"id": "filter", "type": "filter_rows", "name": "Adults", "config": operations[2]},
        {"id": "rename", "type": "rename_columns", "name": "Rename person", "config": operations[3]},
        {"id": "output", "type": "csv_output", "name": "Output", "config": {"filename": "people-cleaned"}},
    ]
    workflow_edges = [
        {"id": f"edge-{index}", "source": first, "target": second}
        for index, (first, second) in enumerate(zip(
            ["input", "trim", "duplicates", "filter", "rename"],
            ["trim", "duplicates", "filter", "rename", "output"],
        ))
    ]
    workflow = client.post("/api/workflows", json={
        "name": "Cleaning preview parity",
        "nodes": workflow_nodes,
        "edges": workflow_edges,
    })
    assert workflow.status_code == 201, workflow.json
    execution = client.post(f"/api/workflows/{workflow.json['workflow_id']}/execute")
    assert execution.status_code == 200, execution.json
    workflow_output = client.get(
        f"/api/files/{execution.json['output_file_ids'][0]}/preview?page_size=50",
    ).json
    assert workflow_output["columns"] == preview.json["after"]["columns"]
    assert workflow_output["rows"] == preview.json["after"]["rows"]

    saved = client.post(
        f"/api/files/{source['file_id']}/clean",
        json={"operations": operations},
    )
    assert saved.status_code == 201, saved.json
    processed_id = saved.json["dataset"]["file_id"]
    processed_preview = client.get(f"/api/files/{processed_id}/preview?page_size=50").json
    assert processed_preview["columns"] == preview.json["after"]["columns"]
    assert processed_preview["rows"] == preview.json["after"]["rows"]
    assert (storage.uploads_dir / source["stored_name"]).read_bytes() == b"name,age\n Alice ,20\nBob,30\nBob,30\nCara,40\n"
