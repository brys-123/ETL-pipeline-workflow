from datetime import datetime, timezone
from typing import Any

from .storage_manager_types import PostgreSQLStorageError, StorageUnavailableError

_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS files (
        file_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('uploaded', 'processed')),
        filename TEXT NOT NULL,
        uploaded_at TIMESTAMPTZ,
        metadata JSONB NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS datasets (
        dataset_id TEXT PRIMARY KEY,
        file_id TEXT,
        source_type TEXT NOT NULL,
        file_reference TEXT,
        file_format TEXT,
        file_size BIGINT,
        row_count BIGINT,
        column_count BIGINT,
        schema_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        metadata JSONB NOT NULL
    )
    """,
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'datasets_file_id_fkey' AND conrelid = 'public.datasets'::regclass
        ) THEN
            ALTER TABLE datasets ADD CONSTRAINT datasets_file_id_fkey
            FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE;
        END IF;
    END $$
    """,
    """
    CREATE TABLE IF NOT EXISTS workflows (
        workflow_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        definition JSONB NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS workflow_executions (
        execution_id TEXT PRIMARY KEY,
        workflow_id TEXT,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        record JSONB NOT NULL
    )
    """,
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'workflow_executions_workflow_id_fkey' AND conrelid = 'public.workflow_executions'::regclass
        ) THEN
            ALTER TABLE workflow_executions ADD CONSTRAINT workflow_executions_workflow_id_fkey
            FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE SET NULL;
        END IF;
    END $$
    """,
    """
    CREATE TABLE IF NOT EXISTS execution_node_results (
        execution_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        output_available BOOLEAN NOT NULL DEFAULT FALSE,
        result JSONB NOT NULL,
        PRIMARY KEY (execution_id, node_id)
    )
    """,
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'execution_node_results_execution_id_fkey' AND conrelid = 'public.execution_node_results'::regclass
        ) THEN
            ALTER TABLE execution_node_results ADD CONSTRAINT execution_node_results_execution_id_fkey
            FOREIGN KEY (execution_id) REFERENCES workflow_executions(execution_id) ON DELETE CASCADE;
        END IF;
    END $$
    """,
    """
    CREATE TABLE IF NOT EXISTS dashboards (
        dashboard_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        dataset_id TEXT,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        definition JSONB NOT NULL
    )
    """,
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'dashboards_dataset_id_fkey' AND conrelid = 'public.dashboards'::regclass
        ) THEN
            ALTER TABLE dashboards ADD CONSTRAINT dashboards_dataset_id_fkey
            FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE SET NULL;
        END IF;
    END $$
    """,
    """
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_files_status_uploaded_at ON files (status, uploaded_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_datasets_source_type_updated_at ON datasets (source_type, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_workflows_updated_at ON workflows (updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_executions_status_started_at ON workflow_executions (status, started_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_executions_workflow_id ON workflow_executions (workflow_id)",
    "CREATE INDEX IF NOT EXISTS idx_dashboards_dataset_id ON dashboards (dataset_id)",
)
MIGRATION_NAME = "initial_metadata_schema"

_AUTH_SCHEMA_STATEMENTS = (
    "ALTER TABLE files ADD COLUMN IF NOT EXISTS owner_id TEXT",
    "ALTER TABLE datasets ADD COLUMN IF NOT EXISTS owner_id TEXT",
    "ALTER TABLE workflows ADD COLUMN IF NOT EXISTS owner_id TEXT",
    "ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS owner_id TEXT",
    "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS owner_id TEXT",
    """
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        profile_picture TEXT,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'locked')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_login_at TIMESTAMPTZ,
        failed_login_count INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_token_hash TEXT NOT NULL UNIQUE,
        csrf_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        last_activity_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        idle_timeout_seconds INTEGER NOT NULL,
        ip_address TEXT,
        user_agent TEXT NOT NULL DEFAULT '',
        remember BOOLEAN NOT NULL DEFAULT FALSE,
        revoked_at TIMESTAMPTZ
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS user_activity_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        ip_address TEXT,
        created_at TIMESTAMPTZ NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_files_owner_id ON files (owner_id)",
    "CREATE INDEX IF NOT EXISTS idx_datasets_owner_id ON datasets (owner_id)",
    "CREATE INDEX IF NOT EXISTS idx_workflows_owner_id ON workflows (owner_id)",
    "CREATE INDEX IF NOT EXISTS idx_executions_owner_id ON workflow_executions (owner_id)",
    "CREATE INDEX IF NOT EXISTS idx_dashboards_owner_id ON dashboards (owner_id)",
    "CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id)",
    "CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions (expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_user_activity_user_created ON user_activity_logs (user_id, created_at DESC)",
)
_MIGRATIONS = (
    (1, MIGRATION_NAME, _SCHEMA_STATEMENTS),
    (2, "authentication_and_resource_ownership", _AUTH_SCHEMA_STATEMENTS),
)
CURRENT_SCHEMA_VERSION = _MIGRATIONS[-1][0]

_REQUIRED_IDENTIFIERS = {
    "files": {"file_id"},
    "datasets": {"dataset_id"},
    "workflows": {"workflow_id"},
    "workflow_executions": {"execution_id"},
    "execution_node_results": {"execution_id", "node_id"},
    "dashboards": {"dashboard_id"},
    "users": {"id"},
    "user_sessions": {"id"},
    "user_activity_logs": {"id"},
    "schema_migrations": {"version"},
}

_REQUIRED_COLUMNS = {
    "files": {"file_id", "status", "filename", "uploaded_at", "metadata", "owner_id"},
    "datasets": {"dataset_id", "file_id", "source_type", "metadata", "owner_id"},
    "workflows": {"workflow_id", "name", "definition", "owner_id"},
    "workflow_executions": {"execution_id", "workflow_id", "status", "record", "owner_id"},
    "execution_node_results": {"execution_id", "node_id", "status", "result"},
    "dashboards": {"dashboard_id", "dataset_id", "definition", "owner_id"},
    "users": {"id", "full_name", "username", "email", "password_hash", "role", "status", "created_at"},
    "user_sessions": {"id", "user_id", "session_token_hash", "csrf_hash", "created_at", "last_activity_at", "expires_at", "revoked_at"},
    "user_activity_logs": {"id", "user_id", "action", "created_at"},
    "schema_migrations": {"version", "name", "applied_at"},
}


def _psycopg_modules():
    try:
        import psycopg
        from psycopg import sql
        from psycopg.rows import dict_row
        from psycopg.types.json import Jsonb
    except ImportError as exc:
        raise PostgreSQLStorageError(
            "The Psycopg PostgreSQL driver is missing from the Python environment running the application. "
            "Install the backend requirements with that interpreter and restart the application."
        ) from exc
    return psycopg, sql, dict_row, Jsonb


def postgres_driver_status() -> dict[str, Any]:
    try:
        _psycopg_modules()
    except PostgreSQLStorageError as exc:
        return {"available": False, "error": str(exc)}
    return {"available": True, "error": None}


def validate_postgres_config(config: object) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(config, dict):
        return None, "Database configuration must be an object."
    host = config.get("host")
    username = config.get("username")
    database = config.get("database")
    maintenance_database = config.get("maintenance_database", "postgres")
    port = config.get("port")
    if not isinstance(host, str) or not host.strip() or len(host.strip()) > 253:
        return None, "Enter a valid PostgreSQL host."
    if not isinstance(username, str) or not username.strip() or len(username.strip()) > 128:
        return None, "Enter a valid PostgreSQL username."
    for label, value in (("database name", database), ("maintenance database", maintenance_database)):
        if not isinstance(value, str) or not value.strip() or len(value) > 63:
            return None, f"Enter a valid {label}."
        if not value[0].isalpha() and value[0] != "_":
            return None, f"Enter a valid {label}."
        if any(not (char.isalnum() or char == "_") for char in value):
            return None, f"Enter a valid {label}."
    if database == maintenance_database:
        return None, "Application database and maintenance database must be different."
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        return None, "Enter a valid PostgreSQL port."
    return {
        "host": host.strip(),
        "port": port,
        "database": database,
        "username": username.strip(),
        "maintenance_database": maintenance_database,
    }, None


def _as_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except ValueError:
        return None


class PostgreSQLStorage:
    def __init__(self, configuration):
        self.configuration = configuration

    def support_status(self) -> dict[str, Any]:
        return postgres_driver_status()

    def _connect(self, database: str | None = None, config: dict[str, Any] | None = None, password: str | None = None):
        psycopg, _, dict_row, _ = _psycopg_modules()
        active = config or self.configuration.postgres
        secret = password if password is not None else self.configuration.password
        if not secret:
            raise PostgreSQLStorageError(
                "A PostgreSQL password is not configured. Enter one in Settings or set POSTGRES_PASSWORD."
            )
        try:
            return psycopg.connect(
                host=active["host"],
                port=active["port"],
                dbname=database or active["database"],
                user=active["username"],
                password=secret,
                connect_timeout=5,
                options="-c search_path=public",
                row_factory=dict_row,
            )
        except psycopg.Error as exc:
            from psycopg.errors import (
                InsufficientPrivilege,
                InvalidAuthorizationSpecification,
                InvalidCatalogName,
                InvalidPassword,
            )

            if isinstance(exc, InvalidPassword):
                raise PostgreSQLStorageError("Invalid database username or password.") from exc
            if isinstance(exc, InvalidAuthorizationSpecification):
                raise PostgreSQLStorageError("The configured PostgreSQL username does not exist or is not permitted to log in.") from exc
            if isinstance(exc, InsufficientPrivilege):
                raise PostgreSQLStorageError("The configured PostgreSQL user does not have the required permissions.") from exc
            if isinstance(exc, InvalidCatalogName):
                raise PostgreSQLStorageError("The configured PostgreSQL database does not exist.") from exc
            if isinstance(exc, psycopg.OperationalError):
                details = str(exc).lower()
                if "no password supplied" in details or "fe_sendauth" in details:
                    raise PostgreSQLStorageError("A PostgreSQL password is required for this server.") from exc
                if "connection refused" in details or "actively refused" in details:
                    raise PostgreSQLStorageError(
                        f"Connection refused by PostgreSQL at {active['host']}:{active['port']}. "
                        "Check that the server is running and accepting connections."
                    ) from exc
                if "timeout expired" in details or "timed out" in details:
                    raise PostgreSQLStorageError(
                        f"PostgreSQL at {active['host']}:{active['port']} did not respond before the connection timed out."
                    ) from exc
                if "could not translate host name" in details or "name or service not known" in details:
                    raise PostgreSQLStorageError(
                        f"The PostgreSQL host name {active['host']} could not be resolved."
                    ) from exc
            raise PostgreSQLStorageError(
                f"Unable to connect to PostgreSQL at {active['host']}:{active['port']}. "
                "Check the connection settings and server status."
            ) from exc

    def test_connection(self, config: dict[str, Any], password: str | None = None) -> dict[str, Any]:
        validated, error = validate_postgres_config(config)
        if error or validated is None:
            raise ValueError(error or "Database configuration is invalid.")
        connection = self._connect(validated["maintenance_database"], validated, password)
        try:
            with connection:
                row = connection.execute(
                    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s) AS database_exists, "
                    "(SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user) AS can_create_database",
                    (validated["database"],),
                ).fetchone()
            database_accessible = False
            schema = {"initialized": False, "schema_version": None}
            if row["database_exists"]:
                application = self._connect(validated["database"], validated, password)
                try:
                    with application:
                        application.execute("SELECT 1")
                    database_accessible = True
                finally:
                    application.close()
                try:
                    schema = self.schema_status(password)
                except PostgreSQLStorageError:
                    pass
            return {
                "connection_successful": True,
                "database_exists": bool(row["database_exists"]),
                "database_accessible": database_accessible,
                "can_create_database": bool(row["can_create_database"]),
                "schema_initialized": schema["initialized"],
                "schema_version": schema["schema_version"],
                "message": "PostgreSQL connection successful.",
            }
        finally:
            connection.close()

    def initialize(self, password: str | None = None) -> dict[str, Any]:
        config, error = validate_postgres_config(self.configuration.postgres)
        if error or config is None:
            raise ValueError(error or "Database configuration is invalid.")
        maintenance = self._connect(config["maintenance_database"], config, password)
        created = False
        try:
            maintenance.autocommit = True
            row = maintenance.execute(
                "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s) AS database_exists, "
                "(SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user) AS can_create_database",
                (config["database"],),
            ).fetchone()
            if not row["database_exists"]:
                if not row["can_create_database"]:
                    raise PostgreSQLStorageError(
                        "The configured PostgreSQL user cannot create databases. Grant CREATEDB or create the application database manually, then retry."
                    )
                _, sql, _, _ = _psycopg_modules()
                try:
                    maintenance.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(config["database"])))
                    created = True
                except _psycopg_modules()[0].errors.DuplicateDatabase:
                    created = False
        except PostgreSQLStorageError:
            raise
        except Exception as exc:
            raise PostgreSQLStorageError(
                "The PostgreSQL application database could not be created or inspected."
            ) from exc
        finally:
            maintenance.close()

        application = self._connect(config["database"], config, password)
        try:
            with application:
                migration_table = application.execute(
                    "SELECT to_regclass('public.schema_migrations') AS migration_table"
                ).fetchone()["migration_table"]
                if migration_table:
                    migration_columns = {
                        row["column_name"] for row in application.execute(
                            "SELECT column_name FROM information_schema.columns "
                            "WHERE table_schema = 'public' AND table_name = 'schema_migrations'"
                        ).fetchall()
                    }
                    missing_migration_columns = _REQUIRED_COLUMNS["schema_migrations"] - migration_columns
                    if missing_migration_columns:
                        raise PostgreSQLStorageError(
                            "Database schema is incompatible: the schema migration table is incomplete."
                        )
                    applied = application.execute(
                        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
                    ).fetchone()["version"]
                else:
                    applied = 0
                if applied > CURRENT_SCHEMA_VERSION:
                    raise PostgreSQLStorageError(
                        "The database schema is newer than this application supports. Upgrade the application before initializing."
                    )
                self._inspect_existing_schema(application)
                if applied == CURRENT_SCHEMA_VERSION:
                    self._verify_schema(application)
                else:
                    application.execute(
                        "CREATE TABLE IF NOT EXISTS schema_migrations ("
                        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, "
                        "applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)"
                    )
                    for version, name, statements in _MIGRATIONS:
                        if version <= applied:
                            continue
                        for statement in statements:
                            application.execute(statement)
                        application.execute(
                            "INSERT INTO schema_migrations (version, name) VALUES (%s, %s) ON CONFLICT (version) DO NOTHING",
                            (version, name),
                        )
                    self._verify_schema(application)
        except PostgreSQLStorageError:
            raise
        except Exception as exc:
            raise PostgreSQLStorageError(
                "Database initialization could not be completed. Check database permissions and schema compatibility."
            ) from exc
        finally:
            application.close()
        return {
            "initialized": True,
            "database_created": created,
            "schema_version": CURRENT_SCHEMA_VERSION,
            "tables": sorted(_REQUIRED_COLUMNS),
            "message": "Database initialized successfully. PostgreSQL is ready.",
        }

    @staticmethod
    def _inspect_existing_schema(connection) -> None:
        existing = {
            row["table_name"] for row in connection.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
            ).fetchall()
        }
        for table in existing.intersection(_REQUIRED_COLUMNS):
            columns = {
                row["column_name"] for row in connection.execute(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = %s",
                    (table,),
                ).fetchall()
            }
            missing = _REQUIRED_IDENTIFIERS[table] - columns
            if missing:
                raise PostgreSQLStorageError(
                    f"Database schema is incompatible: existing table '{table}' is missing required columns."
                )

    @staticmethod
    def _verify_schema(connection) -> None:
        tables = connection.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
        ).fetchall()
        existing_tables = {row["table_name"] for row in tables}
        for table, required in _REQUIRED_COLUMNS.items():
            if table not in existing_tables:
                raise PostgreSQLStorageError(f"Database schema is incomplete: required table '{table}' is missing.")
            columns = connection.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = %s",
                (table,),
            ).fetchall()
            missing = required - {row["column_name"] for row in columns}
            if missing:
                raise PostgreSQLStorageError(
                    f"Database schema is incompatible: table '{table}' is missing required columns."
                )
        foreign_keys = {
            row["table_name"]: row["constraint_name"] for row in connection.execute(
                "SELECT table_name, constraint_name FROM information_schema.table_constraints "
                "WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY'"
            ).fetchall()
        }
        expected_foreign_keys = {
            "datasets": "datasets_file_id_fkey",
            "workflow_executions": "workflow_executions_workflow_id_fkey",
            "execution_node_results": "execution_node_results_execution_id_fkey",
            "dashboards": "dashboards_dataset_id_fkey",
            "user_sessions": "user_sessions_user_id_fkey",
            "user_activity_logs": "user_activity_logs_user_id_fkey",
        }
        if any(foreign_keys.get(table) != name for table, name in expected_foreign_keys.items()):
            raise PostgreSQLStorageError("Database schema is incomplete: required relationships are missing.")
        primary_keys = {
            row["table_name"] for row in connection.execute(
            "SELECT table_name FROM information_schema.table_constraints "
            "WHERE constraint_schema = 'public' AND constraint_type = 'PRIMARY KEY'"
            ).fetchall()
        }
        if not set(_REQUIRED_COLUMNS).issubset(primary_keys):
            raise PostgreSQLStorageError("Database schema is incomplete: required primary keys are missing.")
        indexes = {
            row["indexname"]: row["tablename"] for row in connection.execute(
                "SELECT indexname, tablename FROM pg_indexes WHERE schemaname = 'public'"
            ).fetchall()
        }
        expected_indexes = {
            "idx_files_status_uploaded_at": "files",
            "idx_datasets_source_type_updated_at": "datasets",
            "idx_workflows_updated_at": "workflows",
            "idx_executions_status_started_at": "workflow_executions",
            "idx_executions_workflow_id": "workflow_executions",
            "idx_dashboards_dataset_id": "dashboards",
            "idx_files_owner_id": "files",
            "idx_datasets_owner_id": "datasets",
            "idx_workflows_owner_id": "workflows",
            "idx_executions_owner_id": "workflow_executions",
            "idx_dashboards_owner_id": "dashboards",
            "idx_user_sessions_user_id": "user_sessions",
            "idx_user_sessions_expiry": "user_sessions",
            "idx_user_activity_user_created": "user_activity_logs",
        }
        if any(indexes.get(name) != table for name, table in expected_indexes.items()):
            raise PostgreSQLStorageError("Database schema is incomplete: required indexes are missing.")

    def schema_status(self, password: str | None = None) -> dict[str, Any]:
        connection = self._connect(password=password)
        try:
            with connection:
                migration_table = connection.execute(
                    "SELECT to_regclass('public.schema_migrations') AS migration_table"
                ).fetchone()["migration_table"]
                if not migration_table:
                    raise PostgreSQLStorageError(
                        "Database schema is not initialized. Initialize it from Settings."
                    )
                version = connection.execute(
                    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
                ).fetchone()["version"]
                if version > CURRENT_SCHEMA_VERSION:
                    raise PostgreSQLStorageError(
                        "The database schema is newer than this application supports. Upgrade the application."
                    )
                self._verify_schema(connection)
            return {"initialized": version >= CURRENT_SCHEMA_VERSION, "schema_version": version}
        except PostgreSQLStorageError:
            raise
        except Exception as exc:
            raise PostgreSQLStorageError(
                "The PostgreSQL schema could not be verified. Initialize the database or check its permissions."
            ) from exc
        finally:
            connection.close()

    def list_migrations(self) -> list[dict[str, Any]]:
        connection = self._connect()
        try:
            with connection:
                exists = connection.execute(
                    "SELECT to_regclass('public.schema_migrations') AS migration_table"
                ).fetchone()["migration_table"]
                if not exists:
                    return []
                migrations = connection.execute(
                    "SELECT version, name, applied_at FROM schema_migrations ORDER BY version"
                ).fetchall()
                return [
                    {**migration, "applied_at": migration["applied_at"].isoformat()}
                    for migration in migrations
                ]
        except PostgreSQLStorageError:
            raise
        except Exception as exc:
            raise PostgreSQLStorageError("The schema migration history could not be read.") from exc
        finally:
            connection.close()

    def _run(self, operation):
        connection = self._connect()
        try:
            with connection:
                return operation(connection)
        except PostgreSQLStorageError:
            raise
        except Exception as exc:
            raise StorageUnavailableError(
                "PostgreSQL storage is unavailable or its schema is not initialized. Check the Settings page."
            ) from exc
        finally:
            connection.close()

    @staticmethod
    def _record(row: dict[str, Any] | None, key: str) -> dict[str, Any] | None:
        return row[key] if row and isinstance(row.get(key), dict) else None

    def list_dataset_registry(self) -> list[dict[str, Any]]:
        return self._run(lambda conn: [row["metadata"] for row in conn.execute(
            "SELECT metadata FROM datasets ORDER BY updated_at DESC NULLS LAST"
        ).fetchall()])

    def get_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        return self._run(lambda conn: self._record(conn.execute(
            "SELECT metadata FROM datasets WHERE dataset_id = %s", (dataset_id,)
        ).fetchone(), "metadata"))

    def save_dataset(self, record: dict[str, Any]) -> None:
        _, _, _, Jsonb = _psycopg_modules()
        dataset_id = record.get("dataset_id") or record.get("file_id")
        if not isinstance(dataset_id, str) or not dataset_id:
            raise ValueError("Dataset identifier is invalid.")
        file_id = record.get("file_id") if isinstance(record.get("file_id"), str) else None
        dataset_record = {**record, "file_id": file_id}
        self._run(lambda conn: self._save_dataset_tx(conn, dataset_record, dataset_id, Jsonb))

    @staticmethod
    def _save_dataset_tx(connection, record: dict[str, Any], dataset_id: str, Jsonb) -> None:
        stored_name = record.get("stored_name")
        file_reference = record.get("file_reference") or record.get("storage_path")
        if not file_reference and isinstance(stored_name, str):
            folder = "processed" if record.get("status") == "processed" else "uploads"
            file_reference = f"{folder}/{stored_name}"
        row_count = record.get("row_count")
        if row_count is None:
            row_count = record.get("rows")
        connection.execute(
            "INSERT INTO datasets (dataset_id, file_id, owner_id, source_type, file_reference, file_format, file_size, "
            "row_count, column_count, schema_metadata, created_at, updated_at, metadata) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (dataset_id) DO UPDATE SET file_id=EXCLUDED.file_id, owner_id=EXCLUDED.owner_id, source_type=EXCLUDED.source_type, "
            "file_reference=EXCLUDED.file_reference, file_format=EXCLUDED.file_format, file_size=EXCLUDED.file_size, "
            "row_count=EXCLUDED.row_count, column_count=EXCLUDED.column_count, schema_metadata=EXCLUDED.schema_metadata, "
            "updated_at=EXCLUDED.updated_at, metadata=EXCLUDED.metadata",
            (
                dataset_id, record.get("file_id"), record.get("owner_id"), record.get("source_type") or "imported",
                file_reference,
                record.get("file_type") or record.get("format"),
                record.get("file_size"), row_count,
                record.get("column_count"), Jsonb(record.get("schema", {})),
                _as_datetime(record.get("uploaded_at") or record.get("created_at")),
                _as_datetime(record.get("last_updated") or record.get("updated_at")),
                Jsonb(record),
            ),
        )

    def delete_dataset(self, dataset_id: str) -> bool:
        return self._run(lambda conn: conn.execute(
            "DELETE FROM datasets WHERE dataset_id = %s", (dataset_id,)
        ).rowcount > 0)

    def list_files(self) -> list[dict[str, Any]]:
        return self._run(lambda conn: [row["metadata"] for row in conn.execute(
            "SELECT metadata FROM files ORDER BY uploaded_at DESC NULLS LAST"
        ).fetchall()])

    def get_file(self, file_id: str) -> dict[str, Any] | None:
        return self._run(lambda conn: self._record(conn.execute(
            "SELECT metadata FROM files WHERE file_id = %s", (file_id,)
        ).fetchone(), "metadata"))

    def save_file(self, record: dict[str, Any]) -> None:
        _, _, _, Jsonb = _psycopg_modules()
        file_id = record.get("file_id")
        if not isinstance(file_id, str) or not file_id:
            raise ValueError("File identifier is invalid.")
        dataset_id = record.get("dataset_id")
        if not isinstance(dataset_id, str) or not dataset_id:
            dataset_id = file_id
        dataset_record = {
            **record,
            "dataset_id": dataset_id,
            "source_type": record.get("source_type") or ("processed" if record.get("status") == "processed" else "imported"),
        }
        self._run(lambda conn: (
            self._save_file_tx(conn, record, file_id, Jsonb),
            self._save_dataset_tx(conn, dataset_record, dataset_id, Jsonb),
        ))

    @staticmethod
    def _save_file_tx(connection, record: dict[str, Any], file_id: str, Jsonb) -> None:
        connection.execute(
            "INSERT INTO files (file_id, status, filename, uploaded_at, owner_id, metadata) VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (file_id) DO UPDATE SET status=EXCLUDED.status, filename=EXCLUDED.filename, "
            "uploaded_at=EXCLUDED.uploaded_at, owner_id=EXCLUDED.owner_id, metadata=EXCLUDED.metadata",
            (
                file_id, record.get("status") or "uploaded", record.get("filename") or file_id,
                _as_datetime(record.get("uploaded_at")), record.get("owner_id"), Jsonb(record),
            ),
        )

    def delete_files(self, file_ids: set[str]) -> None:
        if not file_ids:
            return
        self._run(lambda conn: conn.execute("DELETE FROM files WHERE file_id = ANY(%s)", (list(file_ids),)))

    def delete_file(self, file_id: str) -> None:
        self._run(lambda conn: conn.execute("DELETE FROM files WHERE file_id = %s", (file_id,)))

    def list_workflows(self) -> list[dict[str, Any]]:
        return self._run(lambda conn: [row["definition"] for row in conn.execute(
            "SELECT definition FROM workflows ORDER BY updated_at DESC NULLS LAST"
        ).fetchall()])

    def get_workflow(self, workflow_id: str) -> dict[str, Any] | None:
        return self._run(lambda conn: self._record(conn.execute(
            "SELECT definition FROM workflows WHERE workflow_id = %s", (workflow_id,)
        ).fetchone(), "definition"))

    def save_workflow(self, workflow: dict[str, Any]) -> None:
        _, _, _, Jsonb = _psycopg_modules()
        self._run(lambda conn: conn.execute(
            "INSERT INTO workflows (workflow_id, name, created_at, updated_at, owner_id, definition) VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (workflow_id) DO UPDATE SET name=EXCLUDED.name, updated_at=EXCLUDED.updated_at, owner_id=EXCLUDED.owner_id, definition=EXCLUDED.definition",
            (
                workflow["workflow_id"], workflow.get("name", "Untitled workflow"),
                _as_datetime(workflow.get("created_at")), _as_datetime(workflow.get("updated_at")), workflow.get("owner_id"), Jsonb(workflow),
            ),
        ))

    def delete_workflow(self, workflow_id: str) -> bool:
        return self._run(lambda conn: conn.execute(
            "DELETE FROM workflows WHERE workflow_id = %s", (workflow_id,)
        ).rowcount > 0)

    def list_dashboards(self) -> list[dict[str, Any]]:
        return self._run(lambda conn: [row["definition"] for row in conn.execute(
            "SELECT definition FROM dashboards ORDER BY updated_at DESC NULLS LAST"
        ).fetchall()])

    def get_dashboard(self, dashboard_id: str) -> dict[str, Any] | None:
        return self._run(lambda conn: self._record(conn.execute(
            "SELECT definition FROM dashboards WHERE dashboard_id = %s", (dashboard_id,)
        ).fetchone(), "definition"))

    def save_dashboard(self, dashboard: dict[str, Any]) -> None:
        _, _, _, Jsonb = _psycopg_modules()
        dataset_reference = dashboard.get("dataset_id") or dashboard.get("dataset") or dashboard.get("data_source")
        dataset_id = dataset_reference if isinstance(dataset_reference, str) else None
        self._run(lambda conn: conn.execute(
            "INSERT INTO dashboards (dashboard_id, name, dataset_id, created_at, updated_at, owner_id, definition) "
            "VALUES (%s, %s, (SELECT dataset_id FROM datasets WHERE dataset_id = %s AND owner_id = %s), %s, %s, %s, %s) "
            "ON CONFLICT (dashboard_id) DO UPDATE SET "
            "name=EXCLUDED.name, dataset_id=EXCLUDED.dataset_id, updated_at=EXCLUDED.updated_at, owner_id=EXCLUDED.owner_id, definition=EXCLUDED.definition",
            (
                dashboard["dashboard_id"], dashboard.get("name", "Untitled dashboard"), dataset_id, dashboard.get("owner_id"),
                _as_datetime(dashboard.get("created_at")), _as_datetime(dashboard.get("updated_at")), dashboard.get("owner_id"), Jsonb(dashboard),
            ),
        ))

    def delete_dashboard(self, dashboard_id: str) -> bool:
        return self._run(lambda conn: conn.execute(
            "DELETE FROM dashboards WHERE dashboard_id = %s", (dashboard_id,)
        ).rowcount > 0)

    def list_executions(self) -> list[dict[str, Any]]:
        return self._run(lambda conn: [row["record"] for row in conn.execute(
            "SELECT record FROM workflow_executions ORDER BY started_at DESC NULLS LAST"
        ).fetchall()])

    def get_execution(self, execution_id: str) -> dict[str, Any] | None:
        return self._run(lambda conn: self._record(conn.execute(
            "SELECT record FROM workflow_executions WHERE execution_id = %s", (execution_id,)
        ).fetchone(), "record"))

    def save_execution(self, record: dict[str, Any]) -> None:
        _, _, _, Jsonb = _psycopg_modules()
        execution_id = record.get("execution_id")
        if not isinstance(execution_id, str) or not execution_id:
            raise ValueError("Execution identifier is invalid.")

        def persist(connection) -> None:
            connection.execute(
                "INSERT INTO workflow_executions (execution_id, workflow_id, status, started_at, completed_at, owner_id, record) "
                "VALUES (%s, (SELECT workflow_id FROM workflows WHERE workflow_id = %s AND owner_id = %s), %s, %s, %s, %s, %s) "
                "ON CONFLICT (execution_id) DO UPDATE SET "
                "workflow_id=EXCLUDED.workflow_id, status=EXCLUDED.status, started_at=EXCLUDED.started_at, "
                "completed_at=EXCLUDED.completed_at, owner_id=EXCLUDED.owner_id, record=EXCLUDED.record",
                (
                    execution_id, record.get("workflow_id"), record.get("owner_id"), record.get("status", "running"),
                    _as_datetime(record.get("started_at")), _as_datetime(record.get("completed_at")),
                    record.get("owner_id"), Jsonb(record),
                ),
            )
            connection.execute("DELETE FROM execution_node_results WHERE execution_id = %s", (execution_id,))
            for node_id, result in (record.get("node_statuses") or {}).items():
                connection.execute(
                    "INSERT INTO execution_node_results (execution_id, node_id, status, output_available, result) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (execution_id, node_id, result.get("status", "pending"), bool(result.get("output_available")), Jsonb(result)),
                )

        self._run(persist)

    def delete_executions(self, execution_ids: set[str]) -> int:
        if not execution_ids:
            return 0
        return self._run(lambda conn: conn.execute(
            "DELETE FROM workflow_executions WHERE execution_id = ANY(%s)", (list(execution_ids),)
        ).rowcount)

    def record_counts(self) -> dict[str, int]:
        def counts(connection) -> dict[str, int]:
            files = connection.execute(
                "SELECT COUNT(*) FILTER (WHERE status = 'uploaded') AS uploaded, "
                "COUNT(*) FILTER (WHERE status = 'processed') AS processed FROM files"
            ).fetchone()
            return {
                "uploaded_files": files["uploaded"],
                "processed_datasets": files["processed"],
                "workflows": connection.execute("SELECT COUNT(*) AS count FROM workflows").fetchone()["count"],
                "executions": connection.execute("SELECT COUNT(*) AS count FROM workflow_executions").fetchone()["count"],
                "dashboards": connection.execute("SELECT COUNT(*) AS count FROM dashboards").fetchone()["count"],
            }

        return self._run(counts)

    @staticmethod
    def _auth_user(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        user = dict(row)
        for key in ("created_at", "updated_at", "last_login_at", "locked_until"):
            if user.get(key) is not None:
                user[key] = user[key].isoformat()
        return user

    @staticmethod
    def _auth_session(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        session = dict(row)
        session["token_hash"] = session.pop("session_token_hash")
        for key in ("created_at", "last_activity_at", "expires_at", "revoked_at"):
            if session.get(key) is not None:
                session[key] = session[key].isoformat()
        return session

    def list_users(self) -> list[dict[str, Any]]:
        return self._run(lambda conn: [
            self._auth_user(row)
            for row in conn.execute(
                "SELECT id, full_name, username, email, password_hash, profile_picture, role, status, "
                "created_at, updated_at, last_login_at, failed_login_count, locked_until FROM users ORDER BY created_at"
            ).fetchall()
        ])

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        return self._run(lambda conn: self._auth_user(conn.execute(
            "SELECT id, full_name, username, email, password_hash, profile_picture, role, status, "
            "created_at, updated_at, last_login_at, failed_login_count, locked_until FROM users WHERE id = %s",
            (user_id,),
        ).fetchone()))

    def get_user_by_identity(self, identity: str) -> dict[str, Any] | None:
        return self._run(lambda conn: self._auth_user(conn.execute(
            "SELECT id, full_name, username, email, password_hash, profile_picture, role, status, "
            "created_at, updated_at, last_login_at, failed_login_count, locked_until FROM users "
            "WHERE username = %s OR email = %s LIMIT 1",
            (identity, identity),
        ).fetchone()))

    def create_user(self, user: dict[str, Any]) -> dict[str, Any]:
        _, _, _, _ = _psycopg_modules()

        def persist(connection) -> None:
            connection.execute(
                "INSERT INTO users (id, full_name, username, email, password_hash, profile_picture, role, status, "
                "created_at, updated_at, last_login_at, failed_login_count, locked_until) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    user["id"], user["full_name"], user["username"], user["email"], user["password_hash"],
                    user.get("profile_picture"), user["role"], user["status"], _as_datetime(user["created_at"]),
                    _as_datetime(user["updated_at"]), _as_datetime(user.get("last_login_at")),
                    user.get("failed_login_count", 0), _as_datetime(user.get("locked_until")),
                ),
            )

        try:
            self._run(persist)
        except StorageUnavailableError as exc:
            psycopg, _, _, _ = _psycopg_modules()
            if isinstance(exc.__cause__, psycopg.errors.UniqueViolation):
                raise ValueError("An account already uses that username or email address.") from exc
            raise
        return user

    def save_user(self, user: dict[str, Any]) -> None:
        def persist(connection) -> None:
            connection.execute(
                "UPDATE users SET full_name=%s, username=%s, email=%s, password_hash=%s, profile_picture=%s, "
                "role=%s, status=%s, updated_at=%s, last_login_at=%s, failed_login_count=%s, locked_until=%s "
                "WHERE id=%s",
                (
                    user["full_name"], user["username"], user["email"], user["password_hash"],
                    user.get("profile_picture"), user["role"], user["status"], _as_datetime(user["updated_at"]),
                    _as_datetime(user.get("last_login_at")), user.get("failed_login_count", 0),
                    _as_datetime(user.get("locked_until")), user["id"],
                ),
            )

        try:
            self._run(persist)
        except StorageUnavailableError as exc:
            psycopg, _, _, _ = _psycopg_modules()
            if isinstance(exc.__cause__, psycopg.errors.UniqueViolation):
                raise ValueError("An account already uses that username or email address.") from exc
            raise

    def save_session(self, session: dict[str, Any]) -> None:
        self._run(lambda conn: conn.execute(
            "INSERT INTO user_sessions (id, user_id, session_token_hash, csrf_hash, created_at, last_activity_at, "
            "expires_at, idle_timeout_seconds, ip_address, user_agent, remember, revoked_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET last_activity_at=EXCLUDED.last_activity_at, revoked_at=EXCLUDED.revoked_at",
            (
                session["id"], session["user_id"], session["token_hash"], session["csrf_hash"],
                _as_datetime(session["created_at"]), _as_datetime(session["last_activity_at"]),
                _as_datetime(session["expires_at"]), session["idle_timeout_seconds"], session.get("ip_address"),
                session.get("user_agent", ""), bool(session.get("remember")), _as_datetime(session.get("revoked_at")),
            ),
        ))

    def get_session(self, token_hash: str) -> dict[str, Any] | None:
        return self._run(lambda conn: self._auth_session(conn.execute(
            "SELECT id, user_id, session_token_hash, csrf_hash, created_at, last_activity_at, expires_at, "
            "idle_timeout_seconds, ip_address, user_agent, remember, revoked_at FROM user_sessions "
            "WHERE session_token_hash = %s",
            (token_hash,),
        ).fetchone()))

    def revoke_session(self, session_id: str) -> None:
        self._run(lambda conn: conn.execute(
            "UPDATE user_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=%s AND revoked_at IS NULL",
            (session_id,),
        ))

    def revoke_user_sessions(self, user_id: str, except_session_id: str | None = None) -> None:
        self._run(lambda conn: conn.execute(
            "UPDATE user_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=%s AND id<>%s AND revoked_at IS NULL",
            (user_id, except_session_id or ""),
        ))

    def record_activity(self, item: dict[str, Any]) -> None:
        self._run(lambda conn: conn.execute(
            "INSERT INTO user_activity_logs (id, user_id, action, description, ip_address, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (
                item["id"], item.get("user_id"), item["action"], item.get("description", ""),
                item.get("ip_address"), _as_datetime(item["created_at"]),
            ),
        ))

    def get_activity(self, limit: int = 100) -> list[dict[str, Any]]:
        return self._run(lambda conn: [
            {
                **row,
                "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
            }
            for row in conn.execute(
                "SELECT id, user_id, action, description, ip_address, created_at FROM user_activity_logs "
                "ORDER BY created_at DESC LIMIT %s",
                (max(1, min(1000, limit)),),
            ).fetchall()
        ])

    def list_sessions(self, limit: int = 100) -> list[dict[str, Any]]:
        return self._run(lambda conn: [
            {
                **row,
                "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
                "last_activity_at": row["last_activity_at"].isoformat() if row.get("last_activity_at") else None,
                "expires_at": row["expires_at"].isoformat() if row.get("expires_at") else None,
                "revoked_at": row["revoked_at"].isoformat() if row.get("revoked_at") else None,
            }
            for row in conn.execute(
                "SELECT s.id, s.user_id, u.username, s.created_at, s.last_activity_at, s.expires_at, "
                "s.ip_address, s.user_agent, s.remember, s.revoked_at FROM user_sessions s "
                "JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT %s",
                (max(1, min(1000, limit)),),
            ).fetchall()
        ])
