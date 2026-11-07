import io

import pytest

from simple_etl import create_app
from simple_etl.services.metadata_service import MetadataService


@pytest.fixture
def deletion_client(tmp_path):
    app = create_app({
        "TESTING": True,
        "DEBUG": False,
        "STORAGE_ROOT": tmp_path / "storage",
        "MAX_UPLOAD_SIZE_MB": 2,
    })
    return app.test_client(), app.extensions["etl_storage"]


def _upload(client, filename="source.csv"):
    response = client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(b"id,value\n1,a\n2,b\n"), filename)},
        content_type="multipart/form-data",
    )
    assert response.status_code == 201, response.json
    return response.json


def _processed(storage, filename="processed.csv"):
    file_id = storage.new_id()
    content = b"id,value\n1,clean\n"
    path = storage.processed_path(file_id, ".csv")
    path.write_bytes(content)
    record = {
        "file_id": file_id,
        "filename": filename,
        "file_type": "csv",
        "file_size": len(content),
        "uploaded_at": "2026-01-01T00:00:00+00:00",
        "status": "processed",
        "stored_name": path.name,
        "row_count": 1,
        "column_count": 2,
    }
    MetadataService(storage).save_file(record)
    return record


def test_processed_delete_requires_dependency_confirmation_and_removes_registry(deletion_client):
    client, storage = deletion_client
    original = _upload(client)
    processed = _processed(storage)
    metadata = MetadataService(storage)
    dashboard_id = storage.new_id()
    metadata.save_dashboard({"dashboard_id": dashboard_id, "name": "Sales", "dataset_id": processed["file_id"]})

    blocked = client.delete(f"/api/processed/{processed['file_id']}")
    assert blocked.status_code == 409
    assert blocked.json["dependencies"][processed["file_id"]]["dashboards"][0]["name"] == "Sales"
    assert storage.processed_path(processed["file_id"], ".csv").is_file()
    assert metadata.get_file(processed["file_id"]) is not None

    deleted = client.delete(f"/api/processed/{processed['file_id']}?confirm_dependencies=true")
    assert deleted.status_code == 200, deleted.json
    assert not storage.processed_path(processed["file_id"], ".csv").exists()
    assert metadata.get_file(processed["file_id"]) is None
    assert metadata.get_dataset(processed["file_id"]) is None
    assert storage.upload_path(original["file_id"], ".csv").is_file()
    assert metadata.get_dashboard(dashboard_id) is not None


def test_processed_bulk_and_clear_never_delete_uploaded_files(deletion_client):
    client, storage = deletion_client
    original = _upload(client)
    first = _processed(storage, "first.csv")
    second = _processed(storage, "second.csv")

    selected = client.post("/api/processed/delete-selected", json={"file_ids": [first["file_id"], second["file_id"]]})
    assert selected.status_code == 200, selected.json
    assert selected.json["deleted_count"] == 2
    assert not storage.processed_path(first["file_id"], ".csv").exists()
    assert not storage.processed_path(second["file_id"], ".csv").exists()

    remaining = _processed(storage, "remaining.csv")
    cleared = client.delete("/api/processed/clear")
    assert cleared.status_code == 200, cleared.json
    assert cleared.json["deleted_count"] == 1
    assert not storage.processed_path(remaining["file_id"], ".csv").exists()
    assert storage.upload_path(original["file_id"], ".csv").is_file()
    assert MetadataService(storage).get_file(original["file_id"]) is not None


def test_uploaded_bulk_delete_preflights_workflow_dependencies(deletion_client):
    client, storage = deletion_client
    used = _upload(client, "used.csv")
    other = _upload(client, "other.csv")
    workflow = client.post("/api/workflows", json={
        "name": "Uses source",
        "nodes": [{
            "id": "input",
            "type": "csv_input",
            "name": "Input",
            "config": {"file_id": used["file_id"]},
        }, {
            "id": "output",
            "type": "csv_output",
            "name": "Output",
            "config": {"filename": "result"},
        }],
        "edges": [{"id": "edge", "source": "input", "target": "output"}],
    })
    assert workflow.status_code == 201

    blocked = client.post("/api/files/delete-selected", json={"file_ids": [used["file_id"], other["file_id"]]})
    assert blocked.status_code == 409
    assert storage.upload_path(used["file_id"], ".csv").is_file()
    assert storage.upload_path(other["file_id"], ".csv").is_file()

    deleted = client.post("/api/files/delete-selected", json={
        "file_ids": [used["file_id"], other["file_id"]],
        "confirm_dependencies": True,
    })
    assert deleted.status_code == 200, deleted.json
    assert deleted.json["deleted_count"] == 2
    assert not storage.upload_path(used["file_id"], ".csv").exists()
    assert not storage.upload_path(other["file_id"], ".csv").exists()
    assert MetadataService(storage).get_workflow(workflow.json["workflow_id"]) is not None


def test_clear_uploaded_files_and_missing_physical_file_clean_metadata(deletion_client):
    client, storage = deletion_client
    first = _upload(client, "first.csv")
    second = _upload(client, "second.csv")
    storage.upload_path(first["file_id"], ".csv").unlink()

    cleared = client.delete("/api/files/clear")
    assert cleared.status_code == 200, cleared.json
    assert cleared.json["deleted_count"] == 2
    assert next(item for item in cleared.json["deleted"] if item["file_id"] == first["file_id"])["physical_file_missing"] is True
    assert not storage.upload_path(second["file_id"], ".csv").exists()
    assert MetadataService(storage).list_files() == []


def test_history_clear_removes_only_execution_artifacts(deletion_client):
    client, storage = deletion_client
    output = _processed(storage, "workflow-output.csv")
    metadata = MetadataService(storage)
    workflow_id = storage.new_id()
    execution_id = storage.new_id()
    metadata.save_workflow({"workflow_id": workflow_id, "name": "Keep me", "nodes": [], "edges": []})
    metadata.save_execution({
        "execution_id": execution_id,
        "workflow_id": workflow_id,
        "workflow_name": "Keep me",
        "started_at": "2026-01-01T00:00:00+00:00",
        "status": "completed",
        "output_file_ids": [output["file_id"]],
        "node_statuses": {},
    })
    preview_path = storage.preview_path(execution_id, "node")
    preview_path.write_text("{}", encoding="utf-8")
    execution_log = storage.logs_dir / f"execution-{execution_id}.log"
    execution_log.write_text("execution log", encoding="utf-8")
    app_log = storage.logs_dir / "app.log"
    app_log.write_text("shared application log", encoding="utf-8")

    cleared = client.delete("/api/executions/clear")
    assert cleared.status_code == 200, cleared.json
    assert cleared.json["deleted_count"] == 1
    assert metadata.list_executions() == []
    assert not preview_path.exists()
    assert not execution_log.exists()
    assert app_log.read_text(encoding="utf-8").startswith("shared application log")
    assert metadata.get_workflow(workflow_id) is not None
    assert metadata.get_file(output["file_id"]) is not None
    assert storage.processed_path(output["file_id"], ".csv").is_file()


def test_history_single_and_bulk_deletion_preserve_workflows_and_outputs(deletion_client):
    client, storage = deletion_client
    output = _processed(storage)
    metadata = MetadataService(storage)
    workflow_id = storage.new_id()
    metadata.save_workflow({"workflow_id": workflow_id, "name": "Preserve workflow", "nodes": [], "edges": []})
    execution_ids = [storage.new_id() for _ in range(3)]
    for execution_id in execution_ids:
        metadata.save_execution({
            "execution_id": execution_id,
            "workflow_id": workflow_id,
            "workflow_name": "Preserve workflow",
            "started_at": "2026-01-01T00:00:00+00:00",
            "status": "completed",
            "output_file_ids": [output["file_id"]],
            "node_statuses": {},
        })

    single = client.delete(f"/api/executions/{execution_ids[0]}")
    assert single.status_code == 200, single.json
    selected = client.post("/api/executions/delete-selected", json={"execution_ids": execution_ids[1:]})
    assert selected.status_code == 200, selected.json
    assert selected.json["deleted_count"] == 2
    assert metadata.list_executions() == []
    assert metadata.get_workflow(workflow_id) is not None
    assert metadata.get_file(output["file_id"]) is not None
    assert storage.processed_path(output["file_id"], ".csv").is_file()


def test_delete_rejects_bad_ids_and_reports_partial_bulk_failure(deletion_client, monkeypatch):
    client, storage = deletion_client
    first = _upload(client, "first.csv")
    second = _upload(client, "second.csv")
    metadata = MetadataService(storage)

    assert client.delete("/api/files/not-an-id").status_code == 400
    assert client.delete(f"/api/files/{'a' * 32}").status_code == 404

    original_stage = storage.stage_managed_delete

    def fail_one(path, managed_dir):
        if path.name == first["stored_name"]:
            raise OSError("simulated storage failure")
        return original_stage(path, managed_dir)

    monkeypatch.setattr(storage, "stage_managed_delete", fail_one)
    result = client.post("/api/files/delete-selected", json={"file_ids": [first["file_id"], second["file_id"]]})
    assert result.status_code == 200
    assert result.json["partial"] is True
    assert result.json["deleted_count"] == 1
    assert metadata.get_file(first["file_id"]) is not None
    assert storage.upload_path(first["file_id"], ".csv").is_file()
    assert metadata.get_file(second["file_id"]) is None
    assert not storage.upload_path(second["file_id"], ".csv").exists()


def test_history_delete_preserves_running_executions(deletion_client):
    client, storage = deletion_client
    execution_id = storage.new_id()
    MetadataService(storage).save_execution({
        "execution_id": execution_id,
        "workflow_id": storage.new_id(),
        "workflow_name": "Running",
        "started_at": "2026-01-01T00:00:00+00:00",
        "status": "running",
        "node_statuses": {},
    })

    response = client.delete(f"/api/executions/{execution_id}")
    assert response.status_code == 409
    assert MetadataService(storage).get_execution(execution_id)["status"] == "running"


def test_upload_is_restored_when_metadata_deletion_fails(deletion_client, monkeypatch):
    client, storage = deletion_client
    upload = _upload(client)

    def fail_delete(_metadata, _file_id):
        raise OSError("simulated metadata failure")

    monkeypatch.setattr(MetadataService, "delete_file", fail_delete)
    response = client.delete(f"/api/files/{upload['file_id']}")
    assert response.status_code == 500
    assert storage.upload_path(upload["file_id"], ".csv").is_file()
    assert MetadataService(storage).get_file(upload["file_id"]) is not None


def test_delete_rejects_symlink_to_another_managed_file(deletion_client):
    client, storage = deletion_client
    first = _upload(client, "first.csv")
    second = _upload(client, "second.csv")
    first_path = storage.uploads_dir / first["stored_name"]
    second_path = storage.uploads_dir / second["stored_name"]
    first_path.unlink()
    try:
        first_path.symlink_to(second_path)
    except OSError as exc:
        pytest.skip(f"Symlink creation is unavailable: {exc}")

    response = client.delete(f"/api/files/{first['file_id']}")
    assert response.status_code == 500
    assert first_path.is_symlink()
    assert second_path.is_file()
    assert MetadataService(storage).get_file(first["file_id"]) is not None


def test_history_reports_artifact_cleanup_failure(deletion_client, monkeypatch):
    client, storage = deletion_client
    execution_id = storage.new_id()
    metadata = MetadataService(storage)
    metadata.save_execution({
        "execution_id": execution_id,
        "workflow_id": storage.new_id(),
        "workflow_name": "Artifact failure",
        "started_at": "2026-01-01T00:00:00+00:00",
        "status": "completed",
        "node_statuses": {},
    })
    monkeypatch.setattr(storage, "delete_execution_artifacts", lambda _execution_id: {
        "deleted": [],
        "failed": ["preview.json: simulated unlink failure"],
    })

    response = client.delete(f"/api/executions/{execution_id}")
    assert response.status_code == 200
    assert response.json["partial"] is True
    assert response.json["artifact_failures"] == ["preview.json: simulated unlink failure"]
    assert metadata.get_execution(execution_id) is None


def test_workflow_deletion_preserves_execution_history_and_processed_datasets(deletion_client):
    client, storage = deletion_client
    metadata = MetadataService(storage)
    workflow_id = storage.new_id()
    execution_id = storage.new_id()
    dataset = _processed(storage, "retained-output.csv")
    metadata.save_workflow({
        "workflow_id": workflow_id,
        "name": "Workflow with history",
        "nodes": [],
        "edges": [],
    })
    metadata.save_execution({
        "execution_id": execution_id,
        "workflow_id": workflow_id,
        "workflow_name": "Workflow with history",
        "started_at": "2026-01-01T00:00:00+00:00",
        "status": "completed",
        "output_file_ids": [dataset["file_id"]],
        "node_statuses": {},
    })

    deleted = client.delete(f"/api/workflows/{workflow_id}")

    assert deleted.status_code == 200, deleted.json
    assert deleted.json["executions_preserved"] == 1
    assert metadata.get_workflow(workflow_id) is None
    assert metadata.get_execution(execution_id) is not None
    assert metadata.get_file(dataset["file_id"]) is not None
    assert storage.processed_path(dataset["file_id"], ".csv").is_file()


def test_dashboard_bulk_deletion_keeps_referenced_datasets(deletion_client):
    client, storage = deletion_client
    metadata = MetadataService(storage)
    dataset = _processed(storage, "dashboard-source.csv")
    dashboard_ids = [storage.new_id(), storage.new_id()]
    for index, dashboard_id in enumerate(dashboard_ids):
        metadata.save_dashboard({
            "dashboard_id": dashboard_id,
            "name": f"Dashboard {index}",
            "dataset_id": dataset["file_id"],
        })

    deleted = client.post("/api/dashboards/delete-selected", json={"dashboard_ids": dashboard_ids})

    assert deleted.status_code == 200, deleted.json
    assert deleted.json["deleted_count"] == 2
    assert all(metadata.get_dashboard(dashboard_id) is None for dashboard_id in dashboard_ids)
    assert metadata.get_file(dataset["file_id"]) is not None
    assert storage.processed_path(dataset["file_id"], ".csv").is_file()