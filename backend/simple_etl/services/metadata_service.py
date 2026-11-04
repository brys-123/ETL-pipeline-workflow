from pathlib import Path
from typing import Any

from .storage_service import FileSystemStorage


class MetadataService:
    def __init__(self, storage: FileSystemStorage):
        self.storage = storage
        self.files_index = storage.metadata_dir / "files.json"
        self.executions_index = storage.metadata_dir / "executions.json"

    def list_files(self) -> list[dict[str, Any]]:
        records = self.storage.read_json(self.files_index, [])
        if not isinstance(records, list):
            raise RuntimeError("File metadata is invalid.")
        return records

    def get_file(self, file_id: str) -> dict[str, Any] | None:
        return next((record for record in self.list_files() if record.get("file_id") == file_id), None)

    def save_file(self, record: dict[str, Any]) -> None:
        records = self.list_files()
        records = [item for item in records if item.get("file_id") != record["file_id"]]
        records.append(record)
        self.storage.write_json(self.files_index, records)

    def delete_file(self, file_id: str) -> None:
        self.storage.write_json(
            self.files_index,
            [record for record in self.list_files() if record.get("file_id") != file_id],
        )

    def list_workflows(self) -> list[dict[str, Any]]:
        workflows: list[dict[str, Any]] = []
        for path in self.storage.workflows_dir.glob("*.json"):
            try:
                workflow = self.storage.read_json(path, None)
                if isinstance(workflow, dict) and workflow.get("workflow_id") == path.stem:
                    workflows.append(workflow)
            except RuntimeError:
                continue
        return sorted(workflows, key=lambda item: item.get("updated_at", ""), reverse=True)

    def get_workflow(self, workflow_id: str) -> dict[str, Any] | None:
        path = self.storage.workflow_path(workflow_id)
        workflow = self.storage.read_json(path, None)
        return workflow if isinstance(workflow, dict) and workflow.get("workflow_id") == workflow_id else None

    def save_workflow(self, workflow: dict[str, Any]) -> None:
        path = self.storage.workflow_path(workflow["workflow_id"])
        self.storage.write_json(path, workflow)

    def delete_workflow(self, workflow_id: str) -> bool:
        path = self.storage.workflow_path(workflow_id)
        if not path.exists():
            return False
        path.unlink()
        return True

    def list_executions(self) -> list[dict[str, Any]]:
        executions = self.storage.read_json(self.executions_index, [])
        if not isinstance(executions, list):
            raise RuntimeError("Execution metadata is invalid.")
        return executions