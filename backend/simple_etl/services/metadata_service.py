from hashlib import sha256
from pathlib import Path
from typing import Any

from .storage_service import FileSystemStorage


class MetadataService:
    def __init__(self, storage: FileSystemStorage):
        self.storage = storage
        self.files_index = storage.metadata_dir / "files.json"
        self.executions_index = storage.metadata_dir / "executions.json"
        self.datasets_dir = storage.datasets_dir

    @staticmethod
    def stable_dataset_id(workflow_id: str, node_id: str) -> str:
        if not workflow_id or not node_id:
            raise ValueError("Workflow and node identifiers are required.")
        return sha256(f"{workflow_id}:{node_id}".encode("utf-8")).hexdigest()[:32]

    def dataset_registry_path(self, dataset_id: str) -> Path:
        if not self.storage.file_id_is_valid(dataset_id):
            raise ValueError("Invalid dataset identifier.")
        path = (self.datasets_dir / f"{dataset_id}.json").resolve()
        if path.parent != self.datasets_dir.resolve():
            raise ValueError("Invalid dataset registry location.")
        return path

    def list_dataset_registry(self) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for path in self.datasets_dir.glob("*.json"):
            try:
                item = self.storage.read_json(path, None)
            except RuntimeError:
                continue
            if isinstance(item, dict):
                entries.append(item)
        return sorted(entries, key=lambda item: item.get("last_updated") or item.get("uploaded_at") or "", reverse=True)

    def get_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        path = self.dataset_registry_path(dataset_id)
        item = self.storage.read_json(path, None)
        return item if isinstance(item, dict) else None

    def save_dataset(self, record: dict[str, Any]) -> None:
        dataset_id = record.get("dataset_id") or record.get("file_id")
        if not isinstance(dataset_id, str) or not self.storage.file_id_is_valid(dataset_id):
            raise ValueError("Dataset identifier is invalid.")
        payload = dict(record)
        payload["dataset_id"] = dataset_id
        payload["source_type"] = payload.get("source_type") or ("processed" if payload.get("status") == "processed" else "imported")
        payload["last_updated"] = payload.get("last_updated") or payload.get("updated_at") or payload.get("uploaded_at") or payload.get("executed_at")
        self.storage.write_json(self.dataset_registry_path(dataset_id), payload)

    def delete_dataset(self, dataset_id: str) -> bool:
        path = self.dataset_registry_path(dataset_id)
        if not path.exists():
            return False
        path.unlink()
        return True

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
        dataset_id = record.get("dataset_id") or record.get("file_id")
        if isinstance(dataset_id, str) and self.storage.file_id_is_valid(dataset_id):
            self.save_dataset({
                **record,
                "dataset_id": dataset_id,
                "source_type": record.get("source_type") or ("processed" if record.get("status") == "processed" else "imported"),
                "last_updated": record.get("last_updated") or record.get("updated_at") or record.get("uploaded_at") or record.get("executed_at"),
            })

    def delete_files(self, file_ids: set[str]) -> None:
        self.storage.write_json(
            self.files_index,
            [record for record in self.list_files() if record.get("file_id") not in file_ids],
        )

    def delete_file(self, file_id: str) -> None:
        self.storage.write_json(
            self.files_index,
            [record for record in self.list_files() if record.get("file_id") != file_id],
        )
        try:
            self.delete_dataset(file_id)
        except ValueError:
            pass

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

    def list_dashboards(self) -> list[dict[str, Any]]:
        dashboards: list[dict[str, Any]] = []
        for path in self.storage.dashboards_dir.glob("*.json"):
            try:
                dashboard = self.storage.read_json(path, None)
                if (
                    isinstance(dashboard, dict)
                    and dashboard.get("dashboard_id") == path.stem
                    and self.storage.file_id_is_valid(path.stem)
                ):
                    dashboards.append(dashboard)
            except RuntimeError:
                continue
        return sorted(dashboards, key=lambda item: item.get("updated_at", ""), reverse=True)

    def get_dashboard(self, dashboard_id: str) -> dict[str, Any] | None:
        path = self.storage.dashboard_path(dashboard_id)
        dashboard = self.storage.read_json(path, None)
        return dashboard if isinstance(dashboard, dict) and dashboard.get("dashboard_id") == dashboard_id else None

    def save_dashboard(self, dashboard: dict[str, Any]) -> None:
        self.storage.write_json(self.storage.dashboard_path(dashboard["dashboard_id"]), dashboard)

    def delete_dashboard(self, dashboard_id: str) -> bool:
        path = self.storage.dashboard_path(dashboard_id)
        if not path.exists():
            return False
        path.unlink()
        return True

    def list_executions(self) -> list[dict[str, Any]]:
        executions = self.storage.read_json(self.executions_index, [])
        if not isinstance(executions, list):
            raise RuntimeError("Execution metadata is invalid.")
        return executions

    def get_execution(self, execution_id: str) -> dict[str, Any] | None:
        return next((item for item in self.list_executions() if item.get("execution_id") == execution_id), None)

    def save_execution(self, record: dict[str, Any]) -> None:
        executions = self.list_executions()
        executions = [item for item in executions if item.get("execution_id") != record.get("execution_id")]
        executions.append(record)
        self.storage.write_json(self.executions_index, executions)