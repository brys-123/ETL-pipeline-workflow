import json

import keyring
import psycopg
import pytest

from simple_etl import create_app
from simple_etl.services import postgres_storage
from simple_etl.services.postgres_storage import (
    CURRENT_SCHEMA_VERSION,
    MIGRATION_NAME,
    PostgreSQLStorageError,
    PostgreSQLStorage,
    _REQUIRED_COLUMNS,
    postgres_driver_status,
    validate_postgres_config,
)


@pytest.fixture
def storage_app(tmp_path, monkeypatch):
    monkeypatch.setattr(keyring, "get_password", lambda *_args, **_kwargs: None)
    app = create_app({
        "TESTING": True,
        "DEBUG": False,
        "STORAGE_ROOT": tmp_path / "storage",
        "MAX_UPLOAD_SIZE_MB": 1,
    })
    return app, app.test_client(), app.extensions["etl_storage"]


def test_fresh_install_uses_filesystem_without_a_database(storage_app):
    app, client, storage = storage_app

    assert storage.active_backend == "filesystem"
    assert storage.configuration.postgres["database"] == "simple_etl_studio_db"
    assert app.extensions["postgresql_driver_status"] == postgres_driver_status()
    assert client.get("/api/storage/status").json["postgresql"]["available"] is True
    assert client.get("/api/storage/status").json["storage_available"] is True
    assert client.get("/api/health").json["active_backend"] == "filesystem"


def test_postgresql_driver_availability_is_reported_separately_from_server_status(monkeypatch):
    monkeypatch.setattr(
        postgres_storage,
        "_psycopg_modules",
        lambda: (_ for _ in ()).throw(PostgreSQLStorageError("Psycopg is missing.")),
    )

    assert postgres_storage.postgres_driver_status() == {
        "available": False,
        "error": "Psycopg is missing.",
    }


@pytest.mark.parametrize(
    ("driver_message", "expected_message"),
    [
        ("connection failed: Connection refused", "Connection refused by PostgreSQL"),
        ("fe_sendauth: no password supplied", "A PostgreSQL password is required"),
    ],
)
def test_postgresql_connection_errors_are_actionable(storage_app, monkeypatch, driver_message, expected_message):
    _app, _client, storage = storage_app

    def fail_connect(**_kwargs):
        raise psycopg.OperationalError(driver_message)

    monkeypatch.setattr(psycopg, "connect", fail_connect)
    with pytest.raises(PostgreSQLStorageError, match=expected_message):
        storage.postgresql._connect(
            "postgres",
            storage.configuration.postgres,
            "supplied-password",
        )


def test_database_config_is_saved_without_exposing_password(storage_app, monkeypatch):
    _app, client, storage = storage_app
    saved_credentials = {}
    monkeypatch.setattr(
        keyring,
        "set_password",
        lambda service, username, password: saved_credentials.update(
            service=service, username=username, password=password,
        ),
    )
    secret = "not-returned-to-the-client"

    response = client.post("/api/storage/config", json={
        "host": "localhost",
        "port": 5432,
        "database": "simple_etl_db",
        "username": "postgres",
        "password": secret,
        "maintenance_database": "postgres",
    })

    assert response.status_code == 200
    assert "password" not in response.json
    assert secret not in response.get_data(as_text=True)
    assert secret not in (storage.metadata_dir / "storage_config.json").read_text(encoding="utf-8")
    assert saved_credentials["password"] == secret
    assert storage.active_backend == "filesystem"


def test_connection_test_is_safe_and_does_not_activate_postgresql(storage_app, monkeypatch):
    _app, client, storage = storage_app
    monkeypatch.setattr(
        storage.postgresql,
        "test_connection",
        lambda _config, _password: {
            "connection_successful": True,
            "database_exists": False,
            "can_create_database": True,
            "message": "PostgreSQL connection successful.",
        },
    )

    response = client.post("/api/storage/postgresql/test-connection", json={
        "host": "localhost",
        "port": 5432,
        "database": "simple_etl_db",
        "username": "postgres",
        "password": "transient-password",
        "maintenance_database": "postgres",
    })

    assert response.status_code == 200
    assert "transient-password" not in response.get_data(as_text=True)
    assert storage.active_backend == "filesystem"
    assert response.json["database_exists"] is False


def test_failed_activation_keeps_filesystem_active(storage_app, monkeypatch):
    _app, client, storage = storage_app
    monkeypatch.setattr(storage.configuration, "_password", "test-password")
    monkeypatch.setattr(
        storage.postgresql,
        "test_connection",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            PostgreSQLStorageError("Unable to connect to PostgreSQL. Check the host, port and server status.")
        ),
    )

    response = client.post("/api/storage/postgresql/activate", json={})

    assert response.status_code == 503
    assert storage.active_backend == "filesystem"
    assert client.get("/api/storage/status").json["active_backend"] == "filesystem"


def test_active_postgresql_does_not_fall_back_after_restart(storage_app):
    app, _client, storage = storage_app
    storage.configuration.set_active_backend("postgresql")

    restarted = create_app({
        "TESTING": True,
        "DEBUG": False,
        "STORAGE_ROOT": storage.root,
        "MAX_UPLOAD_SIZE_MB": 1,
    })
    restarted_client = restarted.test_client()

    assert restarted.extensions["etl_storage"].active_backend == "postgresql"
    response = restarted_client.get("/api/storage/status")
    assert response.status_code == 200
    assert response.json["storage_available"] is False
    assert response.json["active_backend"] == "postgresql"
    unavailable = restarted_client.get("/api/workflows")
    assert unavailable.status_code == 500
    assert not list((storage.root / "workflows").glob("*.json"))


def test_auth_status_reports_active_postgresql_unavailability(storage_app, monkeypatch):
    _app, client, storage = storage_app
    storage.activate("postgresql")
    monkeypatch.setattr(
        storage.postgresql,
        "schema_status",
        lambda: (_ for _ in ()).throw(PostgreSQLStorageError("Connection unavailable.")),
    )

    response = client.get("/api/auth/status")

    assert response.status_code == 503
    assert "active PostgreSQL" in response.json["error"]


def test_postgresql_identifiers_and_port_are_validated():
    valid, error = validate_postgres_config({
        "host": "localhost",
        "port": 5432,
        "database": "simple_etl_db",
        "username": "etl",
        "maintenance_database": "postgres",
    })
    assert error is None
    assert valid["database"] == "simple_etl_db"

    invalid, error = validate_postgres_config({
        "host": "localhost",
        "port": 5432,
        "database": "etl; DROP DATABASE postgres",
        "username": "etl",
        "maintenance_database": "postgres",
    })
    assert invalid is None
    assert "database name" in error


def test_storage_configuration_does_not_rewrite_existing_file_metadata(storage_app, monkeypatch):
    app, _client, storage = storage_app
    files_index = storage.metadata_dir / "files.json"
    original = '[{"file_id":"preserved","filename":"legacy.csv"}]\n'
    files_index.write_text(original, encoding="utf-8")
    monkeypatch.setattr(
        storage.postgresql,
        "initialize",
        lambda _password=None: {
            "initialized": True,
            "database_created": True,
            "schema_version": 1,
            "tables": [],
            "message": "Database initialized successfully. PostgreSQL is ready.",
        },
    )

    response = app.test_client().post("/api/storage/postgresql/initialize", json={})

    assert response.status_code == 200
    assert storage.active_backend == "filesystem"
    assert files_index.read_text(encoding="utf-8") == original
    assert json.loads((storage.metadata_dir / "storage_config.json").read_text(encoding="utf-8"))["active_backend"] == "filesystem"


def test_initialize_endpoint_uses_password_from_settings_form(storage_app, monkeypatch):
    _app, client, storage = storage_app
    received = {}
    monkeypatch.setattr(
        storage.postgresql,
        "initialize",
        lambda password=None: received.update(password=password) or {
            "initialized": True,
            "database_created": True,
            "schema_version": CURRENT_SCHEMA_VERSION,
            "message": "Database initialized successfully.",
        },
    )

    response = client.post(
        "/api/storage/postgresql/initialize",
        json={"password": "transient-password"},
    )

    assert response.status_code == 200
    assert received["password"] == "transient-password"
    assert "transient-password" not in response.get_data(as_text=True)


def test_activate_requires_a_persisted_password(storage_app):
    _app, client, _storage_manager = storage_app

    response = client.post("/api/storage/postgresql/activate", json={})

    assert response.status_code == 400
    assert "Save the PostgreSQL password" in response.json["error"]


class FakeCursor:
    def __init__(self, rows=None, rowcount=0):
        self.rows = rows or []
        self.rowcount = rowcount

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class FakePostgreSQL:
    def __init__(self):
        self.database_exists = True
        self.tables = set()
        self.indexes = {}
        self.foreign_keys = {}
        self.version = 0
        self.data_marker = "existing-records"
        self.migrations = []
        self.statements = []


class FakeConnection:
    def __init__(self, database, state):
        self.database = database
        self.state = state
        self.autocommit = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def close(self):
        return None

    def execute(self, query, params=()):
        statement = str(query).strip()
        self.state.statements.append(statement)
        if "SELECT EXISTS (SELECT 1 FROM pg_database" in statement:
            return FakeCursor([{"database_exists": self.state.database_exists, "can_create_database": True}])
        if "to_regclass('public.schema_migrations')" in statement:
            found = "schema_migrations" in self.state.tables
            return FakeCursor([{"migration_table": "schema_migrations" if found else None}])
        if "COALESCE(MAX(version), 0)" in statement:
            return FakeCursor([{"version": self.state.version}])
        if "information_schema.tables" in statement:
            return FakeCursor([{"table_name": table} for table in sorted(self.state.tables)])
        if "information_schema.columns" in statement:
            table = params[0] if params else "schema_migrations"
            return FakeCursor([{"column_name": column} for column in _REQUIRED_COLUMNS[table]])
        if "constraint_type = 'FOREIGN KEY'" in statement:
            return FakeCursor([
                {"table_name": table, "constraint_name": name}
                for table, name in self.state.foreign_keys.items()
            ])
        if "constraint_type = 'PRIMARY KEY'" in statement:
            return FakeCursor([{"table_name": table} for table in _REQUIRED_COLUMNS])
        if "FROM pg_indexes" in statement:
            return FakeCursor([
                {"indexname": index, "tablename": table}
                for index, table in self.state.indexes.items()
            ])
        if statement.startswith("CREATE TABLE IF NOT EXISTS"):
            table = statement.split("CREATE TABLE IF NOT EXISTS", 1)[1].split("(", 1)[0].strip()
            self.state.tables.add(table)
            for fk_table, constraint in (
                ("user_sessions", "user_sessions_user_id_fkey"),
                ("user_activity_logs", "user_activity_logs_user_id_fkey"),
            ):
                if f"CREATE TABLE IF NOT EXISTS {fk_table}" in statement and "REFERENCES users(id)" in statement:
                    self.state.foreign_keys[fk_table] = constraint
        elif statement.startswith("DO $$"):
            for table, constraint in (
                ("datasets", "datasets_file_id_fkey"),
                ("workflow_executions", "workflow_executions_workflow_id_fkey"),
                ("execution_node_results", "execution_node_results_execution_id_fkey"),
                ("dashboards", "dashboards_dataset_id_fkey"),
            ):
                if f"'{constraint}'" in statement:
                    self.state.foreign_keys[table] = constraint
        elif statement.startswith("CREATE INDEX IF NOT EXISTS"):
            index = statement.split("CREATE INDEX IF NOT EXISTS", 1)[1].split("ON", 1)[0].strip()
            table = statement.split("ON", 1)[1].split("(", 1)[0].strip()
            self.state.indexes[index] = table
        elif statement.startswith("INSERT INTO schema_migrations"):
            self.state.version = params[0]
            self.state.migrations.append((params[0], params[1]))
            self.state.tables.add("schema_migrations")
        return FakeCursor()


def test_postgresql_initialization_is_idempotent_and_preserves_existing_records(storage_app, monkeypatch):
    _app, _client, manager = storage_app
    state = FakePostgreSQL()
    backend = PostgreSQLStorage(manager.configuration)
    monkeypatch.setattr(backend, "_connect", lambda database=None, config=None, password=None: FakeConnection(database, state))

    first = backend.initialize()
    statements_after_first = len(state.statements)
    second = backend.initialize()

    assert first["schema_version"] == CURRENT_SCHEMA_VERSION
    assert second["database_created"] is False
    assert state.version == CURRENT_SCHEMA_VERSION
    assert state.tables == set(_REQUIRED_COLUMNS)
    assert state.data_marker == "existing-records"
    assert not any("DROP " in item.upper() or "TRUNCATE " in item.upper() for item in state.statements)
    assert state.migrations == [(1, MIGRATION_NAME), (2, "authentication_and_resource_ownership")]
    assert statements_after_first < len(state.statements)
