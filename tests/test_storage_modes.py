import io
import json
import re
from contextlib import nullcontext

import pytest

from simple_etl import create_app
from simple_etl.services.metadata_service import MetadataService
from simple_etl.services.postgres_schema import IncompatibleSchemaError, initialize_schema, schema_status
from simple_etl.services.postgres_metadata import PostgresMetadataBackend
from simple_etl.services.storage_manager import StorageManager, StorageUnavailableError
from simple_etl.services.storage_service import FileSystemStorage


class _Cursor:
    def __init__(self, rows=(), rowcount=0):
        self.rows = list(rows)
        self.rowcount = rowcount

    def fetchall(self):
        return list(self.rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None


class _SchemaConnection:
    def __init__(self, tables=None):
        self.tables = set(tables or ())
        self.indexes = set()
        self.foreign_keys = set()
        self.versions = set()
        self.statements = []

    def transaction(self):
        return nullcontext()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement, _params=None):
        query = str(statement)
        self.statements.append(query)
        if "pg_catalog.pg_tables" in query:
            return _Cursor((table,) for table in sorted(self.tables))
        if "FROM schema_migrations" in query:
            return _Cursor((version,) for version in sorted(self.versions))
        if "pg_catalog.pg_indexes" in query:
            return _Cursor((index,) for index in sorted(self.indexes))
        if "pg_catalog.pg_constraint" in query:
            return _Cursor((name,) for name in sorted(self.foreign_keys))
        table = re.search(r"CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)", query, re.IGNORECASE)
        if table:
            self.tables.add(table.group(1).lower())
            if table.group(1).lower() == "datasets":
                self.foreign_keys.add("datasets_file_id_fkey")
            if table.group(1).lower() == "files":
                self.foreign_keys.add("files_workflow_id_fkey")
            if table.group(1).lower() == "workflow_datasets":
                self.foreign_keys.update({"workflow_datasets_workflow_id_fkey", "workflow_datasets_dataset_id_fkey"})
            if table.group(1).lower() == "dashboards":
                self.foreign_keys.add("dashboards_dataset_id_fkey")
            if table.group(1).lower() == "workflow_executions":
                self.foreign_keys.add("workflow_executions_workflow_id_fkey")
            if table.group(1).lower() == "execution_node_results":
                self.foreign_keys.add("execution_node_results_execution_id_fkey")
        index = re.search(r"CREATE INDEX\s+([a-z_]+)", query, re.IGNORECASE)
        if index:
            self.indexes.add(index.group(1))
        if query.startswith("INSERT INTO schema_migrations"):
            self.versions.add(_params[0])
        return _Cursor()


class _MemoryKeyring:
    def __init__(self):
        self.values = {}

    def get_password(self, service, username):
        return self.values.get((service, username))

    def set_password(self, service, username, password):
        self.values[(service, username)] = password

    def delete_password(self, service, username):
        self.values.pop((service, username), None)


class _MaintenanceConnection:
    def __init__(self, database_exists):
        self.database_exists = database_exists
        self.created_databases = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, _params=None):
        query_text = str(query)
        if "pg_roles" in query_text:
            return _Cursor([(True,)])
        if "pg_database" in query_text:
            return _Cursor([(self.database_exists, True)])
        self.created_databases.append(query)
        return _Cursor()


def _json_value(value):
    return value.obj if hasattr(value, "obj") else value


class _RepositoryConnection:
    def __init__(self):
        self.records = {name: {} for name in (
            "workflows", "files", "datasets", "workflow_datasets", "dashboards",
            "workflow_executions", "execution_node_results", "external_connections",
        )}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, params=()):
        query = " ".join(str(query).split())
        if query.startswith("SELECT 1 FROM workflows WHERE"):
            return _Cursor([("present",)] if params[0] in self.records["workflows"] else [])
        if query.startswith("SELECT payload FROM ") and " WHERE " in query:
            table = query.split("SELECT payload FROM ", 1)[1].split(" ", 1)[0]
            if table == "workflow_executions":
                key = params[0]
            elif table == "execution_node_results":
                key = (params[0], params[1])
            else:
                key = params[0]
            record = self.records[table].get(key)
            return _Cursor([(record["payload"],)] if record else [])
        if query.startswith("SELECT payload FROM "):
            table = query.split("SELECT payload FROM ", 1)[1].split(" ", 1)[0]
            return _Cursor((record["payload"],) for record in self.records[table].values())
        if query.startswith("INSERT INTO workflows"):
            workflow_id, _name, _created, _updated, payload = params
            self.records["workflows"][workflow_id] = {"payload": _json_value(payload)}
        elif query.startswith("INSERT INTO external_connections"):
            connection_id, _kind, _name, _updated, payload = params
            self.records["external_connections"][connection_id] = {"payload": _json_value(payload)}
        elif query.startswith("INSERT INTO files"):
            values = list(params)
            file_id, payload = values[0], _json_value(values[-1])
            self.records["files"][file_id] = {"payload": payload}
        elif query.startswith("INSERT INTO datasets"):
            dataset_id, file_id, _source, _created, _updated, payload = params
            self.records["datasets"][dataset_id] = {"file_id": file_id, "payload": _json_value(payload)}
        elif query.startswith("DELETE FROM workflow_datasets"):
            workflow_id = params[0]
            self.records["workflow_datasets"] = {
                key: value for key, value in self.records["workflow_datasets"].items() if key[0] != workflow_id
            }
        elif query.startswith("INSERT INTO workflow_datasets"):
            workflow_id, dataset_id = params
            if dataset_id in self.records["datasets"]:
                self.records["workflow_datasets"][(workflow_id, dataset_id)] = {}
        elif query.startswith("INSERT INTO dashboards"):
            dashboard_id, _name, dataset_id, _created, _updated, payload = params
            self.records["dashboards"][dashboard_id] = {"dataset_id": dataset_id, "payload": _json_value(payload)}
        elif query.startswith("INSERT INTO workflow_executions"):
            execution_id, _workflow_id, _name, _status, _started, _completed, payload = params
            self.records["workflow_executions"][execution_id] = {"payload": _json_value(payload)}
        elif query.startswith("DELETE FROM execution_node_results"):
            execution_id = params[0]
            self.records["execution_node_results"] = {
                key: value for key, value in self.records["execution_node_results"].items() if key[0] != execution_id
            }
        elif query.startswith("INSERT INTO execution_node_results"):
            execution_id, node_id, _node_type, _status, _updated, payload = params
            self.records["execution_node_results"][(execution_id, node_id)] = {"payload": _json_value(payload)}
        elif query.startswith("DELETE FROM workflow_executions WHERE execution_id = %s"):
            key = params[0]
            deleted = self.records["workflow_executions"].pop(key, None)
            if deleted:
                self.records["execution_node_results"] = {
                    node_key: value for node_key, value in self.records["execution_node_results"].items()
                    if node_key[0] != key
                }
            return _Cursor(rowcount=1 if deleted else 0)
        elif query.startswith("DELETE FROM external_connections"):
            deleted = self.records["external_connections"].pop(params[0], None)
            return _Cursor(rowcount=1 if deleted else 0)
        elif query.startswith("DELETE FROM workflow_executions WHERE execution_id = ANY"):
            execution_ids = set(params[0])
            deleted = execution_ids.intersection(self.records["workflow_executions"])
            self.records["workflow_executions"] = {
                key: value for key, value in self.records["workflow_executions"].items() if key not in execution_ids
            }
            self.records["execution_node_results"] = {
                key: value for key, value in self.records["execution_node_results"].items() if key[0] not in execution_ids
            }
            return _Cursor(rowcount=len(deleted))
        elif query.startswith("DELETE FROM files WHERE file_id ="):
            key = params[0]
            deleted = self.records["files"].pop(key, None)
            dataset_ids = [dataset_id for dataset_id, record in self.records["datasets"].items() if record["file_id"] == key]
            for dataset_id in dataset_ids:
                self.records["datasets"].pop(dataset_id, None)
                for relation in [relation for relation in self.records["workflow_datasets"] if relation[1] == dataset_id]:
                    self.records["workflow_datasets"].pop(relation, None)
                for dashboard in self.records["dashboards"].values():
                    if dashboard["dataset_id"] == dataset_id:
                        dashboard["dataset_id"] = None
            return _Cursor(rowcount=1 if deleted else 0)
        return _Cursor()


class _RepositoryCursor(_Cursor):
    def __init__(self, rows=(), rowcount=0):
        super().__init__(rows)
        self.rowcount = rowcount


def test_fresh_app_defaults_to_filesystem_and_keeps_existing_json_records(tmp_path):
    app = create_app({"TESTING": True, "STORAGE_ROOT": tmp_path / "storage"})
    storage = app.extensions["etl_storage"]
    storage.write_json(storage.workflows_dir / f"{'a' * 32}.json", {
        "workflow_id": "a" * 32,
        "name": "Existing filesystem workflow",
    })

    second_app = create_app({"TESTING": True, "STORAGE_ROOT": tmp_path / "storage"})
    manager = second_app.extensions["storage_manager"]
    assert manager.active_backend == "filesystem"
    assert MetadataService(second_app.extensions["etl_storage"]).list_workflows()[0]["name"] == "Existing filesystem workflow"


def test_schema_initialization_is_idempotent_and_verifies_relationships():
    connection = _SchemaConnection()
    initialized = initialize_schema(connection)
    ddl_count = sum(
        statement.lstrip().startswith(("CREATE TABLE", "CREATE INDEX"))
        and "CREATE TABLE IF NOT EXISTS schema_migrations" not in statement
        for statement in connection.statements
    )

    repeated = initialize_schema(connection)
    ddl_count_after_repeat = sum(
        statement.lstrip().startswith(("CREATE TABLE", "CREATE INDEX"))
        and "CREATE TABLE IF NOT EXISTS schema_migrations" not in statement
        for statement in connection.statements
    )
    status = schema_status(connection)

    assert initialized["schema_version"] == "0002_external_connections"
    assert repeated["migrations"] == ["0001_initial", "0002_external_connections"]
    assert ddl_count_after_repeat == ddl_count
    assert status["initialized"] is True


    def test_postgresql_metadata_stores_external_connection_records_in_app_table():
        connection = _RepositoryConnection()
        backend = PostgresMetadataBackend(object())
        backend._connection = lambda: nullcontext(connection)
        record = {
            "connection_id": "e" * 32,
            "kind": "mysql",
            "name": "External sales",
            "updated_at": "2026-01-01T00:00:00+00:00",
        }

        backend.save_connection(record)

        assert backend.get_connection(record["connection_id"]) == record
        assert backend.list_connections() == [record]
        assert backend.delete_connection(record["connection_id"]) is True
        assert backend.get_connection(record["connection_id"]) is None
    assert status["missing_tables"] == []
    assert status["missing_indexes"] == []
    assert status["missing_foreign_keys"] == []


def test_schema_initialization_refuses_existing_unmanaged_database():
    connection = _SchemaConnection({"business_data"})

    with pytest.raises(IncompatibleSchemaError, match="without Simple ETL migration history"):
        initialize_schema(connection)

    assert connection.statements == [
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'"
    ]
    assert connection.tables == {"business_data"}


def test_schema_status_marks_unknown_migration_versions_incompatible():
    connection = _SchemaConnection()
    initialize_schema(connection)
    connection.versions.add("9999_unknown")

    status = schema_status(connection)

    assert status["initialized"] is False
    assert "unsupported" in status["error"].lower()


def test_storage_config_keeps_password_only_in_keyring(tmp_path):
    storage = FileSystemStorage(tmp_path / "storage")
    manager = StorageManager(storage)
    storage.storage_manager = manager
    keyring = _MemoryKeyring()
    manager._keyring = lambda: keyring
    secret = "never-write-this-password"

    response = manager.save_postgresql_config({"host": "db.internal", "database": "etl_db", "username": "etl_user", "password": secret})
    state_text = manager.state_path.read_text(encoding="utf-8")

    assert response["password_configured"] is True
    assert "password" not in response
    assert secret not in state_text
    assert response["host"] == "db.internal"


def test_connection_test_does_not_activate_postgresql(tmp_path):
    storage = FileSystemStorage(tmp_path / "storage")
    manager = StorageManager(storage)
    manager._keyring = lambda: _MemoryKeyring()

    class _Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        @staticmethod
        def execute(query, _params=None):
            if "pg_roles" in query:
                return _Cursor([(True,)])
            return _Cursor([(False,)])

    manager._connection = lambda *_args, **_kwargs: _Connection()
    result = manager.test_postgresql_connection({
        "host": "localhost",
        "port": 5432,
        "database": "new_etl_db",
        "username": "etl_user",
        "maintenance_database": "postgres",
        "password": "temporary-secret",
    })

    assert result["success"] is True
    assert result["database_exists"] is False
    assert result["can_create_database"] is True
    assert manager.active_backend == "filesystem"


def test_postgresql_failure_does_not_fall_back_to_filesystem(tmp_path):
    storage = FileSystemStorage(tmp_path / "storage")
    manager = StorageManager(storage)
    storage.storage_manager = manager
    manager.active_backend = "postgresql"
    keyring = _MemoryKeyring()
    manager._keyring = lambda: keyring
    keyring.set_password("simple-etl-studio-postgresql", manager._credential_user(manager.postgresql_config), "test-only-password")
    manager._connection = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        StorageUnavailableError("Unable to connect to PostgreSQL.")
    )
    workflow_id = "b" * 32
    storage.write_json(storage.workflow_path(workflow_id), {"workflow_id": workflow_id, "name": "Filesystem-only"})

    with pytest.raises(StorageUnavailableError, match="Unable to connect"):
        MetadataService(storage).list_workflows()
    assert storage.workflow_path(workflow_id).is_file()


def test_storage_api_never_returns_password_and_filesystem_is_default(tmp_path):
    app = create_app({"TESTING": True, "STORAGE_ROOT": tmp_path / "storage"})
    client = app.test_client()

    status = client.get("/api/storage/status")
    config = client.get("/api/storage/config")

    assert status.status_code == 200
    assert status.json["active_backend"] == "filesystem"
    assert status.json["storage_health"] == "available"
    assert config.status_code == 200
    assert "password" not in config.json
    assert config.json["password_configured"] is False


def test_existing_settings_file_is_not_overwritten_during_database_setup(tmp_path):
    storage = FileSystemStorage(tmp_path / "storage")
    settings_path = storage.metadata_dir / "settings.json"
    existing = {"custom": "keep", "storage_mode": "local"}
    storage.write_json(settings_path, existing)
    app = create_app({"TESTING": True, "STORAGE_ROOT": tmp_path / "storage"})

    stored = json.loads(settings_path.read_text(encoding="utf-8"))
    assert stored["custom"] == existing["custom"]
    assert app.extensions["storage_manager"].active_backend == "filesystem"


@pytest.mark.parametrize("database_exists", [False, True])
def test_initialize_and_activate_do_not_migrate_filesystem_records(tmp_path, database_exists):
    storage = FileSystemStorage(tmp_path / "storage")
    manager = StorageManager(storage)
    storage.storage_manager = manager
    keyring = _MemoryKeyring()
    manager._keyring = lambda: keyring
    workflow_id = "c" * 32
    filesystem_workflow = {"workflow_id": workflow_id, "name": "Remain in files", "nodes": [], "edges": []}
    metadata = MetadataService(storage)
    metadata.save_workflow(filesystem_workflow)
    workflow_path = storage.workflow_path(workflow_id)
    before = workflow_path.read_bytes()
    maintenance = _MaintenanceConnection(database_exists)
    database = _SchemaConnection()

    def connect(_config, database_name, _password, **_kwargs):
        return maintenance if database_name == "postgres" else database

    manager._connection = connect
    initialized = manager.initialize_postgresql({
        "host": "localhost",
        "port": 5432,
        "database": "etl_db",
        "username": "postgres",
        "maintenance_database": "postgres",
        "password": "temporary-only",
    })

    assert initialized["success"] is True
    assert initialized["database_created"] is (not database_exists)
    assert manager.active_backend == "filesystem"
    assert workflow_path.read_bytes() == before
    assert MetadataService(storage).get_workflow(workflow_id) == filesystem_workflow
    assert "temporary-only" not in manager.state_path.read_text(encoding="utf-8")

    activated = manager.activate_postgresql()
    assert activated["active_backend"] == "postgresql"
    assert manager.active_backend == "postgresql"
    assert MetadataService(storage).backend.__class__.__name__ == "PostgresMetadataBackend"
    restarted_manager = StorageManager(FileSystemStorage(storage.root))
    assert restarted_manager.active_backend == "postgresql"
    returned = manager.activate_filesystem()
    assert returned["active_backend"] == "filesystem"
    assert workflow_path.read_bytes() == before
    assert StorageManager(FileSystemStorage(storage.root)).active_backend == "filesystem"


def test_storage_routes_hide_password_and_report_connection_failures(tmp_path, monkeypatch):
    app = create_app({"TESTING": True, "STORAGE_ROOT": tmp_path / "storage"})
    client = app.test_client()
    manager = app.extensions["storage_manager"]
    keyring = _MemoryKeyring()
    manager._keyring = lambda: keyring
    secret = "route-test-secret"
    saved = client.post("/api/storage/config", json={
        "host": "db.internal",
        "port": 5432,
        "database": "etl_db",
        "username": "etl_user",
        "maintenance_database": "postgres",
        "password": secret,
    })
    assert saved.status_code == 200, saved.json
    assert "password" not in saved.json
    assert secret not in saved.get_data(as_text=True)
    assert secret not in manager.state_path.read_text(encoding="utf-8")
    assert client.get("/api/storage/config").json["password_configured"] is True

    def fail_connect(*_args, **_kwargs):
        import psycopg

        raise psycopg.OperationalError(f"connection refused; password={secret}")

    monkeypatch.setattr("simple_etl.services.storage_manager.psycopg.connect", fail_connect)
    tested = client.post("/api/storage/postgresql/test-connection", json={
        "host": "db.internal",
        "port": 5432,
        "database": "etl_db",
        "username": "etl_user",
        "maintenance_database": "postgres",
        "password": secret,
    })
    assert tested.status_code == 503
    assert "password" not in tested.get_data(as_text=True)
    assert secret not in tested.get_data(as_text=True)
    assert "Unable to connect" in tested.json["error"]
    assert manager.active_backend == "filesystem"


def test_activate_postgresql_failure_keeps_filesystem_active(tmp_path):
    storage = FileSystemStorage(tmp_path / "storage")
    manager = StorageManager(storage)
    manager.active_backend = "filesystem"
    keyring = _MemoryKeyring()
    manager._keyring = lambda: keyring
    keyring.set_password("simple-etl-studio-postgresql", manager._credential_user(manager.postgresql_config), "test-only-password")
    manager._connection = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        StorageUnavailableError("Unable to connect to PostgreSQL.")
    )

    with pytest.raises(StorageUnavailableError, match="Unable to connect"):
        manager.activate_postgresql()
    assert manager.active_backend == "filesystem"


def test_active_postgresql_outage_is_reported_without_filesystem_fallback(tmp_path):
    app = create_app({"TESTING": True, "STORAGE_ROOT": tmp_path / "storage"})
    manager = app.extensions["storage_manager"]
    manager.active_backend = "postgresql"
    keyring = _MemoryKeyring()
    manager._keyring = lambda: keyring
    keyring.set_password("simple-etl-studio-postgresql", manager._credential_user(manager.postgresql_config), "test-only-password")
    manager._connection = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        StorageUnavailableError("Unable to connect to PostgreSQL.")
    )

    response = app.test_client().get("/api/storage/status")

    assert response.status_code == 503
    assert response.json["active_backend"] == "postgresql"
    assert response.json["storage_health"] == "unavailable"
    assert "Unable to connect" in response.json["error"]
    assert response.json["record_counts"] is None


def test_postgresql_repository_round_trips_application_records(tmp_path):
    storage = FileSystemStorage(tmp_path / "storage")
    manager = StorageManager(storage)
    connection = _RepositoryConnection()
    manager._password = lambda *_args, **_kwargs: "test-only-password"
    manager._connection = lambda *_args, **_kwargs: connection
    repository = PostgresMetadataBackend(manager)
    workflow_id = "e" * 32
    file_id = "f" * 32
    dashboard_id = "1" * 32
    execution_id = "2" * 32
    workflow = {
        "workflow_id": workflow_id,
        "name": "PostgreSQL workflow",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
        "nodes": [{"id": "input", "type": "csv_input", "config": {"file_id": file_id}}],
        "edges": [],
    }
    file_record = {
        "file_id": file_id,
        "filename": "source.csv",
        "file_type": "csv",
        "file_size": 20,
        "uploaded_at": "2026-01-01T00:00:00+00:00",
        "status": "uploaded",
        "stored_name": f"{file_id}.csv",
    }
    dashboard = {
        "dashboard_id": dashboard_id,
        "name": "PostgreSQL dashboard",
        "dataset_id": file_id,
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
        "widgets": [],
    }
    execution = {
        "execution_id": execution_id,
        "workflow_id": workflow_id,
        "workflow_name": workflow["name"],
        "started_at": "2026-01-01T00:00:00+00:00",
        "status": "completed",
        "node_statuses": {"input": {"node_type": "csv_input", "status": "success", "rows": 2}},
    }

    repository.save_workflow(workflow)
    repository.save_file(file_record)
    repository.save_dashboard(dashboard)
    repository.save_execution(execution)

    assert repository.get_workflow(workflow_id) == workflow
    assert repository.list_files() == [file_record]
    assert repository.list_dataset_registry()[0]["dataset_id"] == file_id
    assert repository.get_dashboard(dashboard_id) == dashboard
    assert repository.get_execution(execution_id) == execution
    assert (execution_id, "input") in connection.records["execution_node_results"]
    dependencies = repository.dataset_dependencies({file_id})[file_id]
    assert dependencies["workflows"][0]["id"] == workflow_id
    assert dependencies["dashboards"][0]["id"] == dashboard_id

    repository.delete_file(file_id)
    assert repository.get_file(file_id) is None
    assert repository.get_dataset(file_id) is None
    assert repository.get_dashboard(dashboard_id)["dataset_id"] == file_id
    assert repository.delete_executions({execution_id}) == 1
    assert repository.get_execution(execution_id) is None
    assert connection.records["execution_node_results"] == {}


def test_postgresql_repository_sanitizes_query_errors(tmp_path):
    import psycopg

    storage = FileSystemStorage(tmp_path / "storage")
    manager = StorageManager(storage)
    manager._password = lambda *_args, **_kwargs: "database-password"

    class _BrokenConnection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        @staticmethod
        def execute(*_args, **_kwargs):
            raise psycopg.OperationalError("server error included database-password")

    manager._connection = lambda *_args, **_kwargs: _BrokenConnection()
    repository = PostgresMetadataBackend(manager)

    with pytest.raises(StorageUnavailableError, match="Unable to connect") as error:
        repository.list_files()
    assert "database-password" not in str(error.value)


def test_postgresql_mode_routes_records_to_database_and_dataset_bytes_to_files(tmp_path):
    app = create_app({"TESTING": True, "STORAGE_ROOT": tmp_path / "storage"})
    storage = app.extensions["etl_storage"]
    manager = app.extensions["storage_manager"]
    connection = _RepositoryConnection()
    manager.active_backend = "postgresql"
    manager._password = lambda *_args, **_kwargs: "test-only-password"
    manager._connection = lambda *_args, **_kwargs: connection
    client = app.test_client()

    uploaded = client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(b"region,sales\nNorth,2\nSouth,4\n"), "sales.csv")},
        content_type="multipart/form-data",
    )
    assert uploaded.status_code == 201, uploaded.json
    source = uploaded.json
    source_path = storage.upload_path(source["file_id"], ".csv")
    assert source_path.is_file()
    assert client.get("/api/files").json == [source]
    assert not (storage.metadata_dir / "files.json").exists()

    cleaned = client.post(
        f"/api/files/{source['file_id']}/clean",
        json={"operation": "trim_text", "column": "region"},
    )
    assert cleaned.status_code == 201, cleaned.json
    cleaned_id = cleaned.json["dataset"]["file_id"]
    assert storage.processed_path(cleaned_id, ".csv").is_file()

    workflow = client.post("/api/workflows", json={
        "name": "PostgreSQL workflow",
        "nodes": [
            {"id": "input", "type": "csv_input", "name": "Input", "config": {"file_id": source["file_id"]}},
            {"id": "filter", "type": "filter_rows", "name": "North", "config": {"column": "region", "operator": "equals", "value": "North"}},
            {"id": "preview", "type": "preview_data", "name": "Preview", "config": {}},
            {"id": "output", "type": "csv_output", "name": "Output", "config": {"filename": "north"}},
        ],
        "edges": [
            {"id": "a", "source": "input", "target": "filter"},
            {"id": "b", "source": "filter", "target": "preview"},
            {"id": "c", "source": "preview", "target": "output"},
        ],
    })
    assert workflow.status_code == 201, workflow.json
    workflow_id = workflow.json["workflow_id"]
    execution = client.post(f"/api/workflows/{workflow_id}/execute")
    assert execution.status_code == 200, execution.json
    execution_id = execution.json["execution_id"]
    assert execution.json["status"] == "completed"
    node_preview = client.get(
        f"/api/workflows/{workflow_id}/nodes/filter/preview?execution_id={execution_id}"
    )
    assert node_preview.status_code == 200, node_preview.json
    assert node_preview.json["rows"] == [["North", 2]]

    output_id = execution.json["output_file_ids"][0]
    assert storage.processed_path(output_id, ".csv").is_file()
    assert client.get(f"/api/files/{output_id}/download").status_code == 200
    assert client.get("/api/workflows").json[0]["workflow_id"] == workflow_id
    assert client.get("/api/executions").json[0]["execution_id"] == execution_id

    dashboard = client.post("/api/dashboards", json={"name": "Sales", "dataset_id": source["file_id"], "widgets": []})
    assert dashboard.status_code == 201, dashboard.json
    assert client.get("/api/dashboards").json[0]["dashboard_id"] == dashboard.json["dashboard_id"]
    dashboard_data = client.get(f"/api/dashboards/{dashboard.json['dashboard_id']}/data")
    assert dashboard_data.status_code == 200, dashboard_data.json
    assert dashboard_data.json["rows"] == [["North", 2], ["South", 4]]
    assert not (storage.workflows_dir / f"{workflow_id}.json").exists()
    assert not (storage.dashboards_dir / f"{dashboard.json['dashboard_id']}.json").exists()


def test_storage_routes_report_incompatible_schema_and_keep_previous_mode(tmp_path, monkeypatch):
    app = create_app({"TESTING": True, "STORAGE_ROOT": tmp_path / "storage"})
    manager = app.extensions["storage_manager"]
    monkeypatch.setattr(manager, "initialize_postgresql", lambda _payload: (_ for _ in ()).throw(
        IncompatibleSchemaError("Unmanaged schema; initialization stopped.")
    ))

    response = app.test_client().post("/api/storage/postgresql/initialize", json={"database": "existing"})
    assert response.status_code == 409
    assert response.json["error"] == "Unmanaged schema; initialization stopped."
    assert manager.active_backend == "filesystem"


def test_initialize_and_activate_routes_create_schema_without_importing_records(tmp_path):
    app = create_app({"TESTING": True, "STORAGE_ROOT": tmp_path / "storage"})
    storage = app.extensions["etl_storage"]
    manager = app.extensions["storage_manager"]
    keyring = _MemoryKeyring()
    manager._keyring = lambda: keyring
    workflow_id = "d" * 32
    workflow_path = storage.workflow_path(workflow_id)
    original_workflow = {"workflow_id": workflow_id, "name": "File System only", "nodes": [], "edges": []}
    storage.write_json(workflow_path, original_workflow)
    before = workflow_path.read_bytes()
    maintenance = _MaintenanceConnection(False)
    database = _SchemaConnection()
    manager._connection = lambda _config, database_name, _password, **_kwargs: maintenance if database_name == "postgres" else database
    client = app.test_client()
    config = {
        "host": "localhost",
        "port": 5432,
        "database": "etl_db",
        "username": "postgres",
        "maintenance_database": "postgres",
        "password": "temporary-only",
    }

    initialized = client.post("/api/storage/postgresql/initialize", json=config)
    assert initialized.status_code == 200, initialized.json
    assert initialized.json["database_created"] is True
    assert initialized.json["schema_version"] == "0002_external_connections"
    assert manager.active_backend == "filesystem"
    assert workflow_path.read_bytes() == before
    assert "temporary-only" not in manager.state_path.read_text(encoding="utf-8")

    activated = client.post("/api/storage/postgresql/activate", json={})
    assert activated.status_code == 200, activated.json
    assert manager.active_backend == "postgresql"
    assert workflow_path.read_bytes() == before
    assert client.get("/api/storage/config").json.get("password") is None