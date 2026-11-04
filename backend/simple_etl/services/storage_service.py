import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


class FileSystemStorage:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.uploads_dir = self.root / "uploads"
        self.processed_dir = self.root / "processed"
        self.workflows_dir = self.root / "workflows"
        self.logs_dir = self.root / "logs"
        self.metadata_dir = self.root / "metadata"
        for directory in (self.uploads_dir, self.processed_dir, self.workflows_dir, self.logs_dir, self.metadata_dir):
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
        path = (self.uploads_dir / f"{file_id}{extension}").resolve()
        if path.parent != self.uploads_dir.resolve():
            raise ValueError("Invalid stored file location.")
        return path

    def workflow_path(self, workflow_id: str) -> Path:
        if not self.file_id_is_valid(workflow_id):
            raise ValueError("Invalid workflow identifier.")
        path = (self.workflows_dir / f"{workflow_id}.json").resolve()
        if path.parent != self.workflows_dir.resolve():
            raise ValueError("Invalid workflow location.")
        return path

    def write_upload(self, file_id: str, extension: str, content: bytes) -> None:
        self.upload_path(file_id, extension).write_bytes(content)

    def delete_upload(self, file_id: str, extension: str) -> bool:
        path = self.upload_path(file_id, extension)
        if not path.exists():
            return False
        path.unlink()
        return True