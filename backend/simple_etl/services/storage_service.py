import json
import os
import re
import uuid
from hashlib import sha256
from pathlib import Path
from typing import Any

ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


class FileSystemStorage:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.uploads_dir = self.root / "uploads"
        self.processed_dir = self.root / "processed"
        self.workflows_dir = self.root / "workflows"
        self.dashboards_dir = self.root / "dashboards"
        self.logs_dir = self.root / "logs"
        self.metadata_dir = self.root / "metadata"
        self.previews_dir = self.metadata_dir / "previews"
        self.datasets_dir = self.metadata_dir / "datasets"
        for directory in (
            self.uploads_dir,
            self.processed_dir,
            self.workflows_dir,
            self.dashboards_dir,
            self.logs_dir,
            self.metadata_dir,
            self.previews_dir,
            self.datasets_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def new_id() -> str:
        return uuid.uuid4().hex

    def read_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        try:
            with path.open("r", encoding="utf-8") as source:
                return json.load(source)
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError("Stored metadata could not be read.") from exc

    def write_json(self, path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as destination:
                json.dump(value, destination, ensure_ascii=False, indent=2)
                destination.write("\n")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def file_id_is_valid(file_id: str) -> bool:
        return bool(ID_PATTERN.fullmatch(file_id))

    def upload_path(self, file_id: str, extension: str) -> Path:
        if not self.file_id_is_valid(file_id) or extension not in {".csv", ".xlsx", ".json"}:
            raise ValueError("Invalid stored file identifier.")
        candidate = self.uploads_dir / f"{file_id}{extension}"
        path = candidate.resolve()
        if path.parent != self.uploads_dir.resolve() or path != candidate:
            raise ValueError("Invalid stored file location.")
        return path

    def processed_path(self, file_id: str, extension: str) -> Path:
        if not self.file_id_is_valid(file_id) or extension not in {".csv", ".xlsx", ".json"}:
            raise ValueError("Invalid processed file identifier.")
        candidate = self.processed_dir / f"{file_id}{extension}"
        path = candidate.resolve()
        if path.parent != self.processed_dir.resolve() or path != candidate:
            raise ValueError("Invalid processed file location.")
        return path

    def preview_path(self, execution_id: str, node_id: str) -> Path:
        if not self.file_id_is_valid(execution_id) or not isinstance(node_id, str) or not node_id:
            raise ValueError("Invalid execution preview identifier.")
        node_key = sha256(node_id.encode("utf-8")).hexdigest()
        path = (self.previews_dir / f"{execution_id}_{node_key}.json").resolve()
        if path.parent != self.previews_dir.resolve():
            raise ValueError("Invalid execution preview location.")
        return path

    def workflow_path(self, workflow_id: str) -> Path:
        if not self.file_id_is_valid(workflow_id):
            raise ValueError("Invalid workflow identifier.")
        path = (self.workflows_dir / f"{workflow_id}.json").resolve()
        if path.parent != self.workflows_dir.resolve():
            raise ValueError("Invalid workflow location.")
        return path

    def dashboard_path(self, dashboard_id: str) -> Path:
        if not self.file_id_is_valid(dashboard_id):
            raise ValueError("Invalid dashboard identifier.")
        path = (self.dashboards_dir / f"{dashboard_id}.json").resolve()
        if path.parent != self.dashboards_dir.resolve():
            raise ValueError("Invalid dashboard location.")
        return path

    def write_upload(self, file_id: str, extension: str, content: bytes) -> None:
        self.upload_path(file_id, extension).write_bytes(content)

    def delete_upload(self, file_id: str, extension: str) -> bool:
        path = self.upload_path(file_id, extension)
        if not path.exists():
            return False
        path.unlink()
        return True

    def delete_processed(self, file_id: str, extension: str) -> bool:
        path = self.processed_path(file_id, extension)
        if not path.exists():
            return False
        path.unlink()
        return True

    def stage_managed_delete(self, path: Path, managed_dir: Path) -> Path | None:
        root = managed_dir.resolve()
        source = path.resolve()
        if source.parent != root:
            raise ValueError("File is outside its managed storage directory.")
        if not source.exists():
            return None
        staged = root / f".{source.name}.{uuid.uuid4().hex}.deleting"
        os.replace(source, staged)
        return staged

    def restore_managed_delete(self, staged: Path, destination: Path, managed_dir: Path) -> None:
        root = managed_dir.resolve()
        staged_path = staged.resolve()
        destination_path = destination.resolve()
        if staged_path.parent != root or destination_path.parent != root:
            raise ValueError("Staged file is outside its managed storage directory.")
        if staged_path.exists():
            os.replace(staged_path, destination_path)

    def finalize_managed_delete(self, staged: Path, managed_dir: Path) -> None:
        root = managed_dir.resolve()
        staged_path = staged.resolve()
        if staged_path.parent != root:
            raise ValueError("Staged file is outside its managed storage directory.")
        staged_path.unlink(missing_ok=True)

    def delete_execution_artifacts(self, execution_id: str) -> dict[str, list[str]]:
        if not self.file_id_is_valid(execution_id):
            raise ValueError("Invalid execution identifier.")
        candidates = [
            (self.previews_dir, re.compile(rf"^{re.escape(execution_id)}_[a-f0-9]{{64}}\.json$")),
            (self.logs_dir, re.compile(rf"^execution-{re.escape(execution_id)}\.log(?:\.\d+)?$")),
        ]
        result = {"deleted": [], "failed": []}
        for directory, pattern in candidates:
            root = directory.resolve()
            for path in directory.iterdir():
                if not pattern.fullmatch(path.name) or path.resolve().parent != root or not path.is_file():
                    continue
                try:
                    path.unlink()
                    result["deleted"].append(str(path.relative_to(self.root)))
                except OSError as exc:
                    result["failed"].append(f"{path.name}: {exc}")
        return result