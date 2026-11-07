import io
import json
import time

import pandas as pd
from openpyxl import Workbook

from simple_etl import create_app
from simple_etl.services.dataset_service import DatasetService


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


def _workflow(client, nodes, edges, name="Test ETL"):
    response = client.post("/api/workflows", json={"name": name, "nodes": nodes, "edges": edges})
    assert response.status_code == 201, response.json
    return response.json


def test_paged_preview_schema_and_dataset_statistics(tmp_path):
    client, _storage = _client(tmp_path)
    record = _upload(client, "metrics.csv", b"category,value\nA,1\nA,\nB,4\n")

    preview = client.get(f"/api/files/{record['file_id']}/preview?page=2&page_size=1")
    assert preview.status_code == 200
    assert preview.json["rows"] == [["A", None]]
    assert preview.json["page"] == 2
    assert preview.json["total_rows"] == 3
    assert client.get(f"/api/files/{record['file_id']}/preview?page=0").status_code == 400
    assert client.get(f"/api/files/{record['file_id']}/preview?page_size=101").status_code == 400

    details = client.get(f"/api/files/{record['file_id']}/statistics").json
    assert details["rows"] == 3
    assert details["columns"] == 2
    assert details["missing_cells"] == 1
    assert details["duplicate_rows"] == 0
    assert details["numeric_columns"] == ["value"]
    assert details["numeric_summary"]["value"]["mean"] == 2.5
    assert client.get(f"/api/files/{record['file_id']}/schema").json["schema"][0]["name"] == "category"


def test_dataset_inspection_supports_json_and_excel(tmp_path):
    client, _storage = _client(tmp_path)
    json_record = _upload(client, "rows.json", b'[{"name":"A","count":1},{"name":"A","count":1}]')
    workbook_stream = io.BytesIO()
    workbook = Workbook()
    workbook.active.append(["name", "count"])
    workbook.active.append(["B", 2])
    workbook.save(workbook_stream)
    excel_record = _upload(client, "rows.xlsx", workbook_stream.getvalue())

    assert client.get(f"/api/files/{json_record['file_id']}/summary").json["duplicate_rows"] == 1
    excel_preview = client.get(f"/api/files/{excel_record['file_id']}/preview").json
    assert excel_preview["rows"] == [["B", 2]]


def test_cleaning_operations_write_derived_dataset_and_keep_original(tmp_path):
    client, storage = _client(tmp_path)
    original = _upload(client, "dirty.csv", b"name,value\n Alice ,1\nBob,\nAlice,3\n")
    original_path = storage.uploads_dir / original["stored_name"]

    result = client.post(f"/api/files/{original['file_id']}/clean", json={"operation": "trim_text", "column": "name"})
    assert result.status_code == 201
    cleaned = result.json["dataset"]
    assert cleaned["status"] == "processed"
    assert result.json["summary"]["before"]["rows"] == 3
    assert result.json["summary"]["after"]["rows"] == 3
    assert pd.read_csv(storage.processed_dir / cleaned["stored_name"])["name"].tolist() == ["Alice", "Bob", "Alice"]
    assert original_path.read_bytes() == b"name,value\n Alice ,1\nBob,\nAlice,3\n"

    outliers = client.post(
        f"/api/files/{original['file_id']}/clean",
        json={"operation": "inspect_outliers", "column": "value"},
    )
    assert outliers.status_code == 200
    assert "lower_bound" in outliers.json["inspection"]
    assert client.post(f"/api/files/{original['file_id']}/clean", json={
        "operation": "convert_type", "column": "name", "target_type": "integer",
    }).status_code == 400


def test_workflow_validation_topological_order_and_cycle_rejection(tmp_path):
    client, _storage = _client(tmp_path)
    input_file = _upload(client, "input.csv", b"category,value\nA,2\n")
    nodes = [
        {"id": "out", "type": "csv_output", "name": "Output", "config": {"filename": "result"}},
        {"id": "source", "type": "csv_input", "name": "Source", "config": {"file_id": input_file["file_id"]}},
        {"id": "select", "type": "select_columns", "name": "Select", "config": {"columns": ["category", "value"]}},
    ]
    edges = [{"id": "one", "source": "source", "target": "select"}, {"id": "two", "source": "select", "target": "out"}]
    workflow = _workflow(client, nodes, edges)
    valid = client.post(f"/api/workflows/{workflow['workflow_id']}/validate")
    assert valid.status_code == 200
    assert valid.json["execution_order"] == ["source", "select", "out"]

    cyclic = client.post("/api/workflows", json={
        "name": "Cycle",
        "nodes": nodes,
        "edges": edges + [{"id": "three", "source": "out", "target": "select"}],
    }).json
    checked = client.post(f"/api/workflows/{cyclic['workflow_id']}/validate")
    assert checked.status_code == 400
    assert any("cycle" in message.lower() for message in checked.json["errors"])


def test_workflow_execution_exports_and_history(tmp_path):
    client, storage = _client(tmp_path)
    source = _upload(client, "sales.csv", b"region,sales\nNorth,2\nNorth,3\nSouth,4\n")
    workflow = _workflow(client, [
        {"id": "input", "type": "csv_input", "name": "Sales", "config": {"file_id": source["file_id"]}},
        {"id": "filter", "type": "filter_rows", "name": "North only", "config": {"column": "region", "operator": "equals", "value": "North"}},
        {"id": "rename", "type": "rename_columns", "name": "Rename sales", "config": {"from": "sales", "to": "amount"}},
        {"id": "output", "type": "csv_output", "name": "CSV", "config": {"filename": "north-sales"}},
    ], [
        {"id": "a", "source": "input", "target": "filter"},
        {"id": "b", "source": "filter", "target": "rename"},
        {"id": "c", "source": "rename", "target": "output"},
    ])

    executed = client.post(f"/api/workflows/{workflow['workflow_id']}/execute")
    assert executed.status_code == 200, executed.json
    run = executed.json
    assert run["status"] == "completed"
    assert run["summary"]["input_rows"] == 3
    assert run["summary"]["final_rows"] == 2
    assert run["operations"][1]["type"] == "filter_rows"
    output_id = run["output_file_ids"][0]
    output = client.get(f"/api/files/{output_id}/download")
    assert output.status_code == 200
    assert b"North,2" in output.data
    assert client.get(f"/api/files/{output_id}/preview").json["columns"] == ["region", "amount"]
    assert client.get("/api/executions").json[0]["execution_id"] == run["execution_id"]
    stored = json.loads((storage.metadata_dir / "executions.json").read_text(encoding="utf-8"))
    assert stored[0]["status"] == "completed"


def test_each_workflow_node_preview_returns_its_execution_output(tmp_path):
    client, storage = _client(tmp_path)
    source = _upload(client, "customers.csv", b"id,name,region\n1,Ada,North\n1,Ada,North\n2,Lin,South\n3,Grace,North\n")
    workflow = _workflow(client, [
        {"id": "input", "type": "csv_input", "name": "Customers", "config": {"file_id": source["file_id"]}},
        {"id": "dedupe", "type": "remove_duplicates", "name": "Remove duplicates", "config": {}},
        {"id": "filter", "type": "filter_rows", "name": "North only", "config": {"column": "region", "operator": "equals", "value": "North"}},
        {"id": "rename", "type": "rename_columns", "name": "Rename customer", "config": {"from": "name", "to": "customer"}},
        {"id": "preview", "type": "preview_data", "name": "Preview", "config": {}},
        {"id": "output", "type": "csv_output", "name": "CSV", "config": {"filename": "customers"}},
    ], [
        {"id": "a", "source": "input", "target": "dedupe"},
        {"id": "b", "source": "dedupe", "target": "filter"},
        {"id": "c", "source": "filter", "target": "rename"},
        {"id": "d", "source": "rename", "target": "preview"},
        {"id": "e", "source": "preview", "target": "output"},
    ])

    run = client.post(f"/api/workflows/{workflow['workflow_id']}/execute")
    assert run.status_code == 200, run.json
    execution_id = run.json["execution_id"]
    expected_rows = {"input": 4, "dedupe": 3, "filter": 2, "rename": 2, "preview": 2, "output": 2}
    for node_id, row_count in expected_rows.items():
        response = client.get(
            f"/api/workflows/{workflow['workflow_id']}/nodes/{node_id}/preview"
            f"?execution_id={execution_id}"
        )
        assert response.status_code == 200, response.json
        assert response.json["execution_id"] == execution_id
        assert response.json["status"] == "success"
        assert response.json["total_rows"] == row_count
        assert response.json["page_size"] == 50
        assert response.json["preview"]["node_id"] == node_id
    renamed = client.get(
        f"/api/workflows/{workflow['workflow_id']}/nodes/rename/preview?execution_id={execution_id}"
    ).json
    assert renamed["columns"] == ["id", "customer", "region"]
    assert renamed["rows"][0][1] == "Ada"
    latest = client.get(f"/api/workflows/{workflow['workflow_id']}/nodes/rename/preview")
    assert latest.status_code == 200
    assert latest.json["execution_id"] == execution_id

    rename_node = next(node for node in workflow["nodes"] if node["id"] == "rename")
    rename_node["config"]["from"] = "missing"
    updated = client.post("/api/workflows", json=workflow)
    assert updated.status_code == 200, updated.json
    failed = client.post(f"/api/workflows/{workflow['workflow_id']}/execute")
    assert failed.status_code == 422, failed.json
    executions = json.loads((storage.metadata_dir / "executions.json").read_text(encoding="utf-8"))
    workflow_runs = [item for item in executions if item["workflow_id"] == workflow["workflow_id"]]
    for item in workflow_runs:
        item["started_at"] = "2026-01-01T00:00:00+00:00"
    storage.write_json(storage.metadata_dir / "executions.json", executions)
    latest_failure = client.get(f"/api/workflows/{workflow['workflow_id']}/nodes/rename/preview")
    assert latest_failure.status_code == 200
    assert latest_failure.json["execution_id"] == failed.json["execution"]["execution_id"]
    assert latest_failure.json["status"] == "failed"
    assert "existing column" in latest_failure.json["error"]
    assert latest_failure.json["rows"] == []


def test_preview_node_can_be_a_workflow_terminal(tmp_path):
    client, _storage = _client(tmp_path)
    source = _upload(client, "input.csv", b"value\n1\n2\n")
    workflow = _workflow(client, [
        {"id": "input", "type": "csv_input", "name": "Input", "config": {"file_id": source["file_id"]}},
        {"id": "preview", "type": "preview_data", "name": "Preview", "config": {}},
    ], [{"id": "edge", "source": "input", "target": "preview"}])

    validation = client.post(f"/api/workflows/{workflow['workflow_id']}/validate")
    assert validation.status_code == 200, validation.json
    run = client.post(f"/api/workflows/{workflow['workflow_id']}/execute")
    assert run.status_code == 200, run.json
    preview = client.get(
        f"/api/workflows/{workflow['workflow_id']}/nodes/preview/preview"
        f"?execution_id={run.json['execution_id']}"
    )
    assert preview.status_code == 200, preview.json
    assert preview.json["rows"] == [[1], [2]]


def test_empty_node_output_preview_keeps_schema(tmp_path):
    client, _storage = _client(tmp_path)
    source = _upload(client, "empty.csv", b"value,name\n")
    workflow = _workflow(client, [
        {"id": "input", "type": "csv_input", "name": "Input", "config": {"file_id": source["file_id"]}},
        {"id": "preview", "type": "preview_data", "name": "Preview", "config": {}},
    ], [{"id": "edge", "source": "input", "target": "preview"}])

    run = client.post(f"/api/workflows/{workflow['workflow_id']}/execute")
    assert run.status_code == 200, run.json
    preview = client.get(
        f"/api/workflows/{workflow['workflow_id']}/nodes/preview/preview"
        f"?execution_id={run.json['execution_id']}"
    )
    assert preview.status_code == 200, preview.json
    assert preview.json["total_rows"] == 0
    assert preview.json["columns"] == ["value", "name"]
    assert preview.json["rows"] == []


def test_failed_workflow_is_recorded_without_outputs(tmp_path):
    client, _storage = _client(tmp_path)
    source = _upload(client, "input.csv", b"name,value\nA,2\n")
    workflow = _workflow(client, [
        {"id": "input", "type": "csv_input", "name": "Input", "config": {"file_id": source["file_id"]}},
        {"id": "rename", "type": "rename_columns", "name": "Bad rename", "config": {"from": "missing", "to": "new"}},
        {"id": "output", "type": "json_output", "name": "JSON", "config": {"filename": "result"}},
    ], [
        {"id": "a", "source": "input", "target": "rename"},
        {"id": "b", "source": "rename", "target": "output"},
    ])
    failed = client.post(f"/api/workflows/{workflow['workflow_id']}/execute")
    assert failed.status_code == 422
    assert failed.json["execution"]["status"] == "failed"
    assert failed.json["execution"]["output_file_ids"] == []
    assert failed.json["failing_node_id"] == "rename"


def test_cleaning_operations_and_processed_dataset_deletion(tmp_path):
    client, storage = _client(tmp_path)
    original = _upload(client, "dirty.csv", b"name,value,keep\nA B@!,1,x\nA B@!,1,x\n,3,y\n")

    cleaned = client.post(
        f"/api/files/{original['file_id']}/clean",
        json={"operation": "remove_unwanted_characters", "column": "name"},
    )
    assert cleaned.status_code == 201
    cleaned_record = cleaned.json["dataset"]
    assert pd.read_csv(storage.processed_dir / cleaned_record["stored_name"])["name"].iloc[0] == "A B"

    operations = [
        ({"operation": "remove_missing_rows"}, 2),
        ({"operation": "remove_duplicates"}, 2),
        ({"operation": "fill_missing", "columns": ["name"], "value": "Guest"}, 3),
        ({"operation": "select_columns", "columns": ["name", "value"]}, 3),
        ({"operation": "remove_columns", "columns": ["keep"]}, 3),
        ({"operation": "rename_column", "from": "name", "to": "customer"}, 3),
        ({"operation": "convert_type", "column": "value", "target_type": "integer"}, 3),
    ]
    for config, expected_rows in operations:
        response = client.post(f"/api/files/{original['file_id']}/clean", json=config)
        assert response.status_code == 201, response.json
        assert response.json["summary"]["after"]["rows"] == expected_rows

    delete = client.delete(f"/api/files/{cleaned_record['file_id']}")
    assert delete.status_code == 200
    assert not (storage.processed_dir / cleaned_record["stored_name"]).exists()
    assert client.get(f"/api/files/{cleaned_record['file_id']}/download").status_code == 404


def test_workflow_merge_uses_two_connected_inputs_and_exports_json(tmp_path):
    client, _storage = _client(tmp_path)
    left = _upload(client, "left.csv", b"id,name\n1,Ada\n2,Lin\n")
    right = _upload(client, "right.csv", b"key,score\n1,90\n2,95\n")
    workflow = _workflow(client, [
        {"id": "left", "type": "csv_input", "name": "Left", "config": {"file_id": left["file_id"]}},
        {"id": "right", "type": "csv_input", "name": "Right", "config": {"file_id": right["file_id"]}},
        {"id": "merge", "type": "merge_data", "name": "Join", "config": {"left_on": "id", "right_on": "key", "how": "inner"}},
        {"id": "output", "type": "json_output", "name": "JSON", "config": {"filename": "joined"}},
    ], [
        {"id": "left-edge", "source": "left", "target": "merge"},
        {"id": "right-edge", "source": "right", "target": "merge"},
        {"id": "output-edge", "source": "merge", "target": "output"},
    ])

    result = client.post(f"/api/workflows/{workflow['workflow_id']}/execute")
    assert result.status_code == 200, result.json
    assert result.json["summary"]["final_rows"] == 2
    output = client.get(f"/api/files/{result.json['output_file_ids'][0]}/download")
    assert output.status_code == 200
    rows = json.loads(output.data)
    assert rows[0]["name"] == "Ada"
    assert rows[1]["score"] == 95
    for node_id in ("left", "right", "merge", "output"):
        preview = client.get(
            f"/api/workflows/{workflow['workflow_id']}/nodes/{node_id}/preview"
            f"?execution_id={result.json['execution_id']}"
        )
        assert preview.status_code == 200, preview.json
        assert preview.json["status"] == "success"
        assert preview.json["total_rows"] == 2


def test_async_workflow_preview_captures_intermediate_data(tmp_path):
    client, _storage = _client(tmp_path)
    source = _upload(client, "sales.csv", b"region,sales\nNorth,2\nSouth,4\n")
    workflow = _workflow(client, [
        {"id": "input", "type": "csv_input", "name": "Sales", "config": {"file_id": source["file_id"]}},
        {"id": "filter", "type": "filter_rows", "name": "North only", "config": {"column": "region", "operator": "equals", "value": "North"}},
        {"id": "preview", "type": "preview_data", "name": "Preview", "config": {}},
        {"id": "output", "type": "csv_output", "name": "CSV", "config": {"filename": "north-sales"}},
    ], [
        {"id": "a", "source": "input", "target": "filter"},
        {"id": "b", "source": "filter", "target": "preview"},
        {"id": "c", "source": "preview", "target": "output"},
    ])

    started = client.post(f"/api/workflows/{workflow['workflow_id']}/run")
    assert started.status_code == 202, started.json
    execution_id = started.json["execution_id"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        execution = client.get(f"/api/executions/{execution_id}").json
        if execution["status"] != "running":
            break
        time.sleep(0.01)

    assert execution["status"] == "completed"
    assert all(status["status"] == "success" for status in execution["node_statuses"].values())
    preview = client.get(f"/api/executions/{execution_id}/previews/preview?page=1&page_size=1")
    assert preview.status_code == 200, preview.json
    assert preview.json["rows"] == [["North", 2]]
    assert preview.json["total_rows"] == 1
    assert preview.json["preview"]["execution_id"] == execution_id


def test_failed_preview_skips_dependents_but_runs_independent_branch(tmp_path, monkeypatch):
    client, _storage = _client(tmp_path)
    first = _upload(client, "first.csv", b"value\n1\n")
    second = _upload(client, "second.csv", b"value\n2\n")
    workflow = _workflow(client, [
        {"id": "first", "type": "csv_input", "name": "First", "config": {"file_id": first["file_id"]}},
        {"id": "preview", "type": "preview_data", "name": "Broken preview", "config": {}},
        {"id": "dependent", "type": "csv_output", "name": "Dependent output", "config": {"filename": "dependent"}},
        {"id": "second", "type": "csv_input", "name": "Second", "config": {"file_id": second["file_id"]}},
        {"id": "independent", "type": "json_output", "name": "Independent output", "config": {"filename": "independent"}},
    ], [
        {"id": "a", "source": "first", "target": "preview"},
        {"id": "b", "source": "preview", "target": "dependent"},
        {"id": "c", "source": "second", "target": "independent"},
    ])

    def fail_preview(_self, _frame, _execution_id, node_id):
        if node_id == "preview":
            raise OSError("Preview storage unavailable")

    monkeypatch.setattr(DatasetService, "write_preview", fail_preview)
    failed = client.post(f"/api/workflows/{workflow['workflow_id']}/execute")
    assert failed.status_code == 422, failed.json
    statuses = failed.json["execution"]["node_statuses"]
    assert statuses["preview"]["status"] == "failed"
    assert "Preview storage unavailable" in statuses["preview"]["error"]
    assert statuses["dependent"]["status"] == "skipped"
    assert statuses["independent"]["status"] == "success"
    assert failed.json["execution"]["output_file_ids"] == []
