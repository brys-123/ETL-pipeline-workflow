from typing import Any

INITIAL_MIGRATION = "0001_initial"
CONNECTIONS_MIGRATION = "0002_external_connections"
MIGRATIONS = {
    INITIAL_MIGRATION: (
        """
        CREATE TABLE workflows (
            workflow_id CHAR(32) PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            payload JSONB NOT NULL
        )
        """,
        """
        CREATE TABLE files (
            file_id CHAR(32) PRIMARY KEY,
            filename VARCHAR(255) NOT NULL,
            file_type VARCHAR(8) NOT NULL CHECK (file_type IN ('csv', 'xlsx', 'json')),
            status VARCHAR(16) NOT NULL CHECK (status IN ('uploaded', 'processed')),
            source_type VARCHAR(24) NOT NULL,
            file_size BIGINT NOT NULL DEFAULT 0 CHECK (file_size >= 0),
            row_count BIGINT,
            column_count INTEGER,
            workflow_id CHAR(32) REFERENCES workflows(workflow_id) ON DELETE SET NULL,
            dataset_revision INTEGER NOT NULL DEFAULT 1 CHECK (dataset_revision > 0),
            uploaded_at TIMESTAMPTZ NOT NULL,
            last_updated TIMESTAMPTZ NOT NULL,
            payload JSONB NOT NULL
        )
        """,
        """
        CREATE TABLE datasets (
            dataset_id CHAR(32) PRIMARY KEY,
            file_id CHAR(32) NOT NULL UNIQUE REFERENCES files(file_id) ON DELETE CASCADE,
            source_type VARCHAR(24) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            payload JSONB NOT NULL
        )
        """,
        """
        CREATE TABLE workflow_datasets (
            workflow_id CHAR(32) NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
            dataset_id CHAR(32) NOT NULL REFERENCES datasets(dataset_id) ON DELETE CASCADE,
            PRIMARY KEY (workflow_id, dataset_id)
        )
        """,
        """
        CREATE TABLE dashboards (
            dashboard_id CHAR(32) PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            dataset_id CHAR(32) REFERENCES datasets(dataset_id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            payload JSONB NOT NULL
        )
        """,
        """
        CREATE TABLE workflow_executions (
            execution_id CHAR(32) PRIMARY KEY,
            workflow_id CHAR(32) REFERENCES workflows(workflow_id) ON DELETE SET NULL,
            workflow_name VARCHAR(120) NOT NULL,
            status VARCHAR(16) NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
            started_at TIMESTAMPTZ NOT NULL,
            completed_at TIMESTAMPTZ,
            payload JSONB NOT NULL
        )
        """,
        """
        CREATE TABLE execution_node_results (
            execution_id CHAR(32) NOT NULL REFERENCES workflow_executions(execution_id) ON DELETE CASCADE,
            node_id VARCHAR(100) NOT NULL,
            node_type VARCHAR(60),
            status VARCHAR(16) NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            payload JSONB NOT NULL,
            PRIMARY KEY (execution_id, node_id)
        )
        """,
        """
        CREATE TABLE storage_settings (
            setting_key VARCHAR(120) PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
        """,
        "CREATE INDEX files_status_uploaded_idx ON files(status, uploaded_at DESC)",
        "CREATE INDEX files_workflow_idx ON files(workflow_id)",
        "CREATE INDEX datasets_source_updated_idx ON datasets(source_type, updated_at DESC)",
        "CREATE INDEX dashboards_dataset_idx ON dashboards(dataset_id)",
        "CREATE INDEX dashboards_updated_idx ON dashboards(updated_at DESC)",
        "CREATE INDEX workflow_datasets_dataset_idx ON workflow_datasets(dataset_id)",
        "CREATE INDEX executions_workflow_started_idx ON workflow_executions(workflow_id, started_at DESC)",
        "CREATE INDEX executions_status_started_idx ON workflow_executions(status, started_at DESC)",
        "CREATE INDEX execution_nodes_status_idx ON execution_node_results(status)",
    ),
    CONNECTIONS_MIGRATION: (
        """
        CREATE TABLE external_connections (
            connection_id CHAR(32) PRIMARY KEY,
            kind VARCHAR(16) NOT NULL CHECK (kind IN ('mysql', 'postgresql', 'api')),
            name VARCHAR(120) NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            payload JSONB NOT NULL
        )
        """,
        "CREATE INDEX external_connections_updated_idx ON external_connections(updated_at DESC)",
    ),
}

REQUIRED_TABLES = {
    "schema_migrations",
    "workflows",
    "files",
    "datasets",
    "dashboards",
    "workflow_executions",
    "execution_node_results",
    "storage_settings",
    "external_connections",
}
REQUIRED_INDEXES = {
    "files_status_uploaded_idx",
    "files_workflow_idx",
    "datasets_source_updated_idx",
    "workflow_datasets_dataset_idx",
    "dashboards_dataset_idx",
    "dashboards_updated_idx",
    "executions_workflow_started_idx",
    "executions_status_started_idx",
    "execution_nodes_status_idx",
    "external_connections_updated_idx",
}
REQUIRED_FOREIGN_KEYS = {
    "files_workflow_id_fkey",
    "datasets_file_id_fkey",
    "workflow_datasets_workflow_id_fkey",
    "workflow_datasets_dataset_id_fkey",
    "dashboards_dataset_id_fkey",
    "workflow_executions_workflow_id_fkey",
    "execution_node_results_execution_id_fkey",
}


class IncompatibleSchemaError(RuntimeError):
    pass


def _public_tables(connection: Any) -> set[str]:
    rows = connection.execute(
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'"
    ).fetchall()
    return {row[0] for row in rows}


def _public_indexes(connection: Any) -> set[str]:
    rows = connection.execute(
        "SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = 'public'"
    ).fetchall()
    return {row[0] for row in rows}


def _foreign_keys(connection: Any) -> set[str]:
    rows = connection.execute(
        "SELECT conname FROM pg_catalog.pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace"
    ).fetchall()
    return {row[0] for row in rows}


def initialize_schema(connection: Any) -> dict[str, Any]:
    existing_tables = _public_tables(connection)
    has_migrations = "schema_migrations" in existing_tables
    unmanaged_tables = existing_tables - {"schema_migrations"}
    if unmanaged_tables and not has_migrations:
        raise IncompatibleSchemaError(
            "The selected database contains tables without Simple ETL migration history. "
            "Initialization stopped without changing it. Choose an empty database or inspect it manually."
        )

    with connection.transaction():
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version VARCHAR(80) PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        applied = {
            row[0]
            for row in connection.execute("SELECT version FROM schema_migrations").fetchall()
        }
        known_versions = list(MIGRATIONS)
        unknown = applied - set(known_versions)
        if unknown:
            raise IncompatibleSchemaError(
                "The database contains unsupported schema migration versions. "
                "No schema changes were applied."
            )
        for version in known_versions:
            if version in applied:
                continue
            for statement in MIGRATIONS[version]:
                connection.execute(statement)
            connection.execute(
                "INSERT INTO schema_migrations(version) VALUES (%s)", (version,)
            )

    tables = _public_tables(connection)
    missing = REQUIRED_TABLES - tables
    if missing:
        raise IncompatibleSchemaError(
            "Database schema verification failed. Missing required application tables."
        )
    if REQUIRED_INDEXES - _public_indexes(connection):
        raise IncompatibleSchemaError("Database schema verification failed. Required indexes are missing.")
    if REQUIRED_FOREIGN_KEYS - _foreign_keys(connection):
        raise IncompatibleSchemaError("Database schema verification failed. Required relationships are missing.")
    migration_rows = connection.execute(
        "SELECT version FROM schema_migrations ORDER BY version"
    ).fetchall()
    versions = [row[0] for row in migration_rows]
    if INITIAL_MIGRATION not in versions:
        raise IncompatibleSchemaError("The initial application schema migration is not recorded.")
    return {
        "schema_version": versions[-1],
        "tables": sorted(REQUIRED_TABLES),
        "indexes": sorted(REQUIRED_INDEXES),
        "foreign_keys": sorted(REQUIRED_FOREIGN_KEYS),
        "migrations": versions,
    }


def schema_status(connection: Any) -> dict[str, Any]:
    tables = _public_tables(connection)
    if "schema_migrations" not in tables:
        return {"initialized": False, "schema_version": None, "tables": sorted(tables), "missing_tables": sorted(REQUIRED_TABLES - tables), "missing_indexes": sorted(REQUIRED_INDEXES), "missing_foreign_keys": sorted(REQUIRED_FOREIGN_KEYS)}
    indexes = _public_indexes(connection)
    foreign_keys = _foreign_keys(connection)
    versions = [
        row[0]
        for row in connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).fetchall()
    ]
    unsupported_versions = set(versions) - set(MIGRATIONS)
    return {
        "initialized": REQUIRED_TABLES.issubset(tables)
        and REQUIRED_INDEXES.issubset(indexes)
        and REQUIRED_FOREIGN_KEYS.issubset(foreign_keys)
        and INITIAL_MIGRATION in versions
        and not unsupported_versions,
        "error": "Database contains unsupported schema migration versions." if unsupported_versions else None,
        "schema_version": versions[-1] if versions else None,
        "tables": sorted(tables),
        "missing_tables": sorted(REQUIRED_TABLES - tables),
        "indexes": sorted(indexes),
        "missing_indexes": sorted(REQUIRED_INDEXES - indexes),
        "foreign_keys": sorted(foreign_keys),
        "missing_foreign_keys": sorted(REQUIRED_FOREIGN_KEYS - foreign_keys),
        "migrations": versions,
    }