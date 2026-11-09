from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .metadata_service import FileSystemMetadataBackend


class PostgresMetadataBackend:
    DATASET_REFERENCE_KEYS = FileSystemMetadataBackend.DATASET_REFERENCE_KEYS
    stable_dataset_id = staticmethod(FileSystemMetadataBackend.stable_dataset_id)

    def __init__(self, manager):
        self.manager = manager
        self.storage = manager.filesystem

    @contextmanager
    def _connection(self):
        config = self.manager.postgresql_config
        password = self.manager._password(config)
        if password is None:
            from .storage_manager import StorageUnavailableError

            raise StorageUnavailableError("PostgreSQL credentials are not configured.")
        from .storage_manager import StorageUnavailableError

        try:
            with self.manager._connection(config, config["database"], password) as connection:
                yield connection
        except psycopg.Error as exc:
            raise StorageUnavailableError(self.manager._safe_connection_error(exc)) from None

    @staticmethod
    def _timestamp(value: Any) -> datetime:
        if isinstance(value, datetime):
            return value
        if isinstance(value, str) and value:
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
            except ValueError:
                pass
        return datetime.now(timezone.utc)

    @staticmethod
    def _payload(row: tuple[Any, ...] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        value = row[0]
        return dict(value) if isinstance(value, dict) else None

    @staticmethod
    def _referenced(value: Any, dataset_id: str) -> bool:
        return FileSystemMetadataBackend._references_dataset(value, dataset_id)

    @staticmethod
    def _file_workflow_id(record: dict[str, Any]) -> str | None:
        workflow_id = record.get("workflow_id")
        return workflow_id if isinstance(workflow_id, str) and len(workflow_id) == 32 else None

    def list_files(self) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute("SELECT payload FROM files ORDER BY uploaded_at DESC, file_id").fetchall()
        return [dict(row[0]) for row in rows]

    def get_file(self, file_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT payload FROM files WHERE file_id = %s", (file_id,)).fetchone()
        return self._payload(row)

    def save_file(self, record: dict[str, Any]) -> None:
        file_id = record["file_id"]
        workflow_id = self._file_workflow_id(record)
        payload = dict(record)
        with self._connection() as connection:
            if workflow_id and not connection.execute(
                "SELECT 1 FROM workflows WHERE workflow_id = %s", (workflow_id,)
            ).fetchone():
                workflow_id = None
            connection.execute(
                """
                INSERT INTO files(
                    file_id, filename, file_type, status, source_type, file_size,
                    row_count, column_count, workflow_id, dataset_revision,
                    uploaded_at, last_updated, payload
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT(file_id) DO UPDATE SET
                    filename = EXCLUDED.filename,
                    file_type = EXCLUDED.file_type,
                    status = EXCLUDED.status,
                    source_type = EXCLUDED.source_type,
                    file_size = EXCLUDED.file_size,
                    row_count = EXCLUDED.row_count,
                    column_count = EXCLUDED.column_count,
                    workflow_id = EXCLUDED.workflow_id,
                    dataset_revision = EXCLUDED.dataset_revision,
                    uploaded_at = EXCLUDED.uploaded_at,
                    last_updated = EXCLUDED.last_updated,
                    payload = EXCLUDED.payload
                """,
                (
                    file_id,
                    str(record.get("filename", file_id))[:255],
                    record.get("file_type", "csv"),
                    record.get("status", "uploaded"),
                    record.get("source_type") or ("processed" if record.get("status") == "processed" else "imported"),
                    max(0, int(record.get("file_size", 0) or 0)),
                    record.get("row_count"),
                    record.get("column_count"),
                    workflow_id,
                    max(1, int(record.get("dataset_version", 1) or 1)),
                    self._timestamp(record.get("uploaded_at")),
                    self._timestamp(record.get("last_updated") or record.get("updated_at") or record.get("uploaded_at")),
                    Jsonb(payload),
                ),
            )
            dataset_id = record.get("dataset_id") or file_id
            if isinstance(dataset_id, str) and self.storage.file_id_is_valid(dataset_id):
                dataset_payload = {
                    **record,
                    "dataset_id": dataset_id,
                    "source_type": record.get("source_type") or ("processed" if record.get("status") == "processed" else "imported"),
                }
                connection.execute(
                    """
                    INSERT INTO datasets(dataset_id, file_id, source_type, created_at, updated_at, payload)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT(dataset_id) DO UPDATE SET
                        file_id = EXCLUDED.file_id,
                        source_type = EXCLUDED.source_type,
                        updated_at = EXCLUDED.updated_at,
                        payload = EXCLUDED.payload
                    """,
                    (
                        dataset_id,
                        file_id,
                        dataset_payload["source_type"],
                        self._timestamp(record.get("uploaded_at")),
                        self._timestamp(record.get("last_updated") or record.get("updated_at") or record.get("uploaded_at")),
                        Jsonb(dataset_payload),
                    ),
                )

    def delete_files(self, file_ids: set[str]) -> None:
        if not file_ids:
            return
        with self._connection() as connection:
            connection.execute("DELETE FROM files WHERE file_id = ANY(%s)", (list(file_ids),))

    def delete_file(self, file_id: str) -> None:
        with self._connection() as connection:
            connection.execute("DELETE FROM files WHERE file_id = %s", (file_id,))

    def list_dataset_registry(self) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute("SELECT payload FROM datasets ORDER BY updated_at DESC, dataset_id").fetchall()
        return [dict(row[0]) for row in rows]

    def get_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT payload FROM datasets WHERE dataset_id = %s", (dataset_id,)).fetchone()
        return self._payload(row)

    def save_dataset(self, record: dict[str, Any]) -> None:
        file_id = record.get("file_id") or record.get("dataset_id")
        self.save_file({**record, "file_id": file_id, "dataset_id": record.get("dataset_id") or file_id})

    def delete_dataset(self, dataset_id: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute("DELETE FROM datasets WHERE dataset_id = %s", (dataset_id,))
        return cursor.rowcount > 0

    def list_workflows(self) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute("SELECT payload FROM workflows ORDER BY updated_at DESC, workflow_id").fetchall()
        return [dict(row[0]) for row in rows]

    def get_workflow(self, workflow_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT payload FROM workflows WHERE workflow_id = %s", (workflow_id,)).fetchone()
        return self._payload(row)

    def save_workflow(self, workflow: dict[str, Any]) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO workflows(workflow_id, name, created_at, updated_at, payload)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT(workflow_id) DO UPDATE SET
                    name = EXCLUDED.name, updated_at = EXCLUDED.updated_at, payload = EXCLUDED.payload
                """,
                (
                    workflow["workflow_id"],
                    str(workflow.get("name", "Workflow"))[:120],
                    self._timestamp(workflow.get("created_at")),
                    self._timestamp(workflow.get("updated_at")),
                    Jsonb(workflow),
                ),
            )
            connection.execute("DELETE FROM workflow_datasets WHERE workflow_id = %s", (workflow["workflow_id"],))
            file_ids = set()
            for node in workflow.get("nodes", []):
                config = node.get("config") if isinstance(node, dict) else None
                file_id = config.get("file_id") if isinstance(config, dict) else None
                if isinstance(file_id, str) and self.storage.file_id_is_valid(file_id):
                    file_ids.add(file_id)
            for file_id in file_ids:
                connection.execute(
                    """
                    INSERT INTO workflow_datasets(workflow_id, dataset_id)
                    SELECT %s, dataset_id FROM datasets WHERE dataset_id = %s
                    ON CONFLICT DO NOTHING
                    """,
                    (workflow["workflow_id"], file_id),
                )

    def delete_workflow(self, workflow_id: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute("DELETE FROM workflows WHERE workflow_id = %s", (workflow_id,))
        return cursor.rowcount > 0

    def list_dashboards(self) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute("SELECT payload FROM dashboards ORDER BY updated_at DESC, dashboard_id").fetchall()
        return [dict(row[0]) for row in rows]

    def get_dashboard(self, dashboard_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT payload FROM dashboards WHERE dashboard_id = %s", (dashboard_id,)).fetchone()
        return self._payload(row)

    def save_dashboard(self, dashboard: dict[str, Any]) -> None:
        dataset_id = dashboard.get("dataset_id") or dashboard.get("dataset") or dashboard.get("data_source")
        dataset_id = dataset_id if isinstance(dataset_id, str) else None
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO dashboards(dashboard_id, name, dataset_id, created_at, updated_at, payload)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT(dashboard_id) DO UPDATE SET
                    name = EXCLUDED.name, dataset_id = EXCLUDED.dataset_id,
                    updated_at = EXCLUDED.updated_at, payload = EXCLUDED.payload
                """,
                (
                    dashboard["dashboard_id"],
                    str(dashboard.get("name", "Dashboard"))[:120],
                    dataset_id,
                    self._timestamp(dashboard.get("created_at")),
                    self._timestamp(dashboard.get("updated_at")),
                    Jsonb(dashboard),
                ),
            )

    def delete_dashboard(self, dashboard_id: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute("DELETE FROM dashboards WHERE dashboard_id = %s", (dashboard_id,))
        return cursor.rowcount > 0

    def list_executions(self) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute("SELECT payload FROM workflow_executions ORDER BY started_at DESC, execution_id").fetchall()
        return [dict(row[0]) for row in rows]

    def get_execution(self, execution_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT payload FROM workflow_executions WHERE execution_id = %s", (execution_id,)).fetchone()
        return self._payload(row)

    def save_execution(self, record: dict[str, Any]) -> None:
        workflow_id = record.get("workflow_id")
        with self._connection() as connection:
            if workflow_id and not connection.execute(
                "SELECT 1 FROM workflows WHERE workflow_id = %s", (workflow_id,)
            ).fetchone():
                workflow_id = None
            connection.execute(
                """
                INSERT INTO workflow_executions(execution_id, workflow_id, workflow_name, status, started_at, completed_at, payload)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT(execution_id) DO UPDATE SET
                    workflow_id = EXCLUDED.workflow_id, workflow_name = EXCLUDED.workflow_name,
                    status = EXCLUDED.status, started_at = EXCLUDED.started_at,
                    completed_at = EXCLUDED.completed_at, payload = EXCLUDED.payload
                """,
                (
                    record["execution_id"], workflow_id,
                    str(record.get("workflow_name", "Workflow"))[:120],
                    record.get("status", "running"),
                    self._timestamp(record.get("started_at")),
                    self._timestamp(record.get("completed_at")) if record.get("completed_at") else None,
                    Jsonb(record),
                ),
            )
            results = record.get("node_statuses", {})
            if not isinstance(results, dict):
                results = {}
            connection.execute("DELETE FROM execution_node_results WHERE execution_id = %s", (record["execution_id"],))
            for node_id, result in results.items():
                if not isinstance(node_id, str) or not isinstance(result, dict):
                    continue
                connection.execute(
                    """
                    INSERT INTO execution_node_results(execution_id, node_id, node_type, status, updated_at, payload)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        record["execution_id"], node_id[:100], result.get("node_type"),
                        result.get("status", "pending"),
                        self._timestamp(result.get("executed_at") or record.get("started_at")),
                        Jsonb(result),
                    ),
                )

    def delete_executions(self, execution_ids: set[str]) -> int:
        if not execution_ids:
            return 0
        with self._connection() as connection:
            cursor = connection.execute(
                "DELETE FROM workflow_executions WHERE execution_id = ANY(%s)",
                (list(execution_ids),),
            )
        return cursor.rowcount

    def dataset_dependencies(self, dataset_ids: set[str]) -> dict[str, dict[str, list[dict[str, str]]]]:
        dependencies = {dataset_id: {"workflows": [], "dashboards": []} for dataset_id in dataset_ids}
        for workflow in self.list_workflows():
            for dataset_id in dataset_ids:
                if self._referenced(workflow.get("nodes", []), dataset_id):
                    dependencies[dataset_id]["workflows"].append({"id": workflow.get("workflow_id", ""), "name": workflow.get("name", "Unnamed workflow")})
        for dashboard in self.list_dashboards():
            for dataset_id in dataset_ids:
                if self._referenced(dashboard, dataset_id):
                    dependencies[dataset_id]["dashboards"].append({"id": dashboard.get("dashboard_id", ""), "name": dashboard.get("name", "Unnamed dashboard")})
        return dependencies

    def get_setting(self, key: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT value FROM storage_settings WHERE setting_key = %s", (key,)).fetchone()
        return dict(row[0]) if row and isinstance(row[0], dict) else None

    def save_setting(self, key: str, value: dict[str, Any]) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO storage_settings(setting_key, value, updated_at) VALUES (%s, %s, NOW())
                ON CONFLICT(setting_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
                """,
                (key, Jsonb(value)),
            )

    def list_connections(self) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute("SELECT payload FROM external_connections ORDER BY name, connection_id").fetchall()
        return [dict(row[0]) for row in rows if isinstance(row[0], dict)]

    def get_connection(self, connection_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT payload FROM external_connections WHERE connection_id = %s", (connection_id,)).fetchone()
        return self._payload(row)

    def save_connection(self, record: dict[str, Any]) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO external_connections(connection_id, kind, name, updated_at, payload)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT(connection_id) DO UPDATE SET
                    kind = EXCLUDED.kind, name = EXCLUDED.name,
                    updated_at = EXCLUDED.updated_at, payload = EXCLUDED.payload
                """,
                (record["connection_id"], record["kind"], record["name"], self._timestamp(record.get("updated_at")), Jsonb(record)),
            )

    def delete_connection(self, connection_id: str) -> bool:
        with self._connection() as connection:
            result = connection.execute("DELETE FROM external_connections WHERE connection_id = %s", (connection_id,))
        return result.rowcount > 0