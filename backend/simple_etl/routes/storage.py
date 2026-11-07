import ipaddress
import shutil

from flask import Blueprint, current_app, jsonify, request

from ..services.postgres_storage import PostgreSQLStorageError, validate_postgres_config
from ..services.metadata_service import MetadataService
from ..services.workflow_execution_service import acquire_storage_switch, release_storage_switch
from ..utils.helpers import utc_now

storage_blueprint = Blueprint("storage", __name__)
SWITCH_WARNING = (
    "Changing the storage mode does not automatically transfer existing records between storage systems. "
    "Records created under the previous mode remain in that storage system."
)


def _local_request() -> bool:
    try:
        return ipaddress.ip_address(request.remote_addr or "").is_loopback
    except ValueError:
        return False


def _require_local():
    if not _local_request():
        return jsonify({"error": "Storage configuration is only available from the local machine."}), 403
    return None


def _storage():
    return current_app.extensions["etl_storage"]


def _config_payload():
    manager = _storage()
    configuration = manager.configuration
    return {
        **configuration.postgres,
        "password_saved": configuration.password_saved,
        "password_source": configuration.password_source,
        "credential_store_available": configuration.credential_store_available,
        "active_backend": manager.active_backend,
        "last_successful_connection": configuration.last_successful_connection,
        "last_initialization": configuration.last_initialization,
    }


def _saved_password(manager) -> str | None:
    return manager.configuration.password


@storage_blueprint.get("/storage/config")
def get_storage_config():
    denied = _require_local()
    if denied:
        return denied
    try:
        return jsonify(_config_payload())
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


@storage_blueprint.post("/storage/config")
def save_storage_config():
    denied = _require_local()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Configuration body must be a JSON object."}), 400
    config = {
        "host": payload.get("host"),
        "port": payload.get("port"),
        "database": payload.get("database"),
        "username": payload.get("username"),
        "maintenance_database": payload.get("maintenance_database") or "postgres",
    }
    normalized, error = validate_postgres_config(config)
    if error or normalized is None:
        return jsonify({"error": error or "Database configuration is invalid."}), 400
    password = payload.get("password")
    if password is not None and (not isinstance(password, str) or len(password) > 1024):
        return jsonify({"error": "Password must be text no longer than 1024 characters."}), 400
    clear_password = payload.get("clear_password", False)
    if not isinstance(clear_password, bool):
        return jsonify({"error": "clear_password must be a boolean."}), 400
    if not acquire_storage_switch():
        return jsonify({"error": "Wait for the running workflow to finish before changing storage settings."}), 409
    try:
        _storage().configuration.save_postgres(normalized, password, clear_password)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503
    finally:
        release_storage_switch()
    return jsonify({"saved": True, **_config_payload()})


@storage_blueprint.get("/storage/status")
def storage_status():
    manager = _storage()
    filesystem = manager.filesystem
    required = (filesystem.uploads_dir, filesystem.processed_dir, filesystem.workflows_dir, filesystem.logs_dir, filesystem.metadata_dir)
    filesystem_available = all(path.is_dir() for path in required)
    try:
        disk_usage = shutil.disk_usage(filesystem.root)
        filesystem_free_bytes = disk_usage.free
        filesystem_total_bytes = disk_usage.total
    except OSError:
        filesystem_free_bytes = None
        filesystem_total_bytes = None
    try:
        if manager.active_backend == "filesystem":
            metadata = MetadataService(manager)
            records = metadata.list_files()
            counts = {
                "uploaded_files": sum(item.get("status") == "uploaded" for item in records),
                "processed_datasets": sum(item.get("status") == "processed" for item in records),
                "workflows": len(metadata.list_workflows()),
                "executions": len(metadata.list_executions()),
                "dashboards": len(metadata.list_dashboards()),
            }
        else:
            counts = manager.postgresql.record_counts()
        active_available = filesystem_available if manager.active_backend == "filesystem" else True
        error = None
    except (OSError, RuntimeError, ValueError) as exc:
        counts = None
        active_available = False
        error = str(exc) if isinstance(exc, PostgreSQLStorageError) else "The selected storage backend is unavailable."

    pg_status = {
        "connection_status": "not tested",
        "database_exists": None,
        "schema_initialized": None,
        "schema_version": None,
        "error": None,
    }
    try:
        if manager.configuration.password:
            test = manager.postgresql.test_connection(
                manager.configuration.postgres,
                manager.configuration.password,
            )
            pg_status["connection_status"] = "connected"
            pg_status["database_exists"] = test["database_exists"]
            if test["database_exists"]:
                try:
                    schema = manager.postgresql.schema_status()
                    pg_status["schema_initialized"] = schema["initialized"]
                    pg_status["schema_version"] = schema["schema_version"]
                except PostgreSQLStorageError as exc:
                    pg_status["schema_initialized"] = False
                    pg_status["error"] = str(exc)
        else:
            pg_status["connection_status"] = "credentials required"
    except (PostgreSQLStorageError, ValueError) as exc:
        pg_status["connection_status"] = "disconnected"
        pg_status["error"] = str(exc)
    return jsonify({
        "active_backend": manager.active_backend,
        "storage_available": active_available,
        "error": error,
        "filesystem": {
            "active": manager.active_backend == "filesystem",
            "available": filesystem_available,
            "location": str(filesystem.root),
            "available_bytes": filesystem_free_bytes,
            "total_bytes": filesystem_total_bytes,
            "counts": counts if manager.active_backend == "filesystem" else None,
        },
        "postgresql": {
            **pg_status,
            "active": manager.active_backend == "postgresql",
            "database": manager.configuration.postgres["database"],
            "password_saved": manager.configuration.password_saved,
            "password_source": manager.configuration.password_source,
            "credential_store_available": manager.configuration.credential_store_available,
            "last_successful_connection": manager.configuration.last_successful_connection,
            "last_initialization": manager.configuration.last_initialization,
            "counts": counts if manager.active_backend == "postgresql" else None,
        },
        "counts": counts,
        "max_upload_size_mb": current_app.config["MAX_UPLOAD_SIZE_MB"],
        "switch_warning": SWITCH_WARNING,
    })


@storage_blueprint.post("/storage/postgresql/test-connection")
def test_postgresql_connection():
    denied = _require_local()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Connection test body must be a JSON object."}), 400
    config = {name: payload.get(name) for name in (
        "host", "port", "database", "username", "maintenance_database",
    )}
    config["maintenance_database"] = config["maintenance_database"] or "postgres"
    normalized, error = validate_postgres_config(config)
    if error or normalized is None:
        return jsonify({"error": error or "Database configuration is invalid."}), 400
    password = payload.get("password")
    if password is None:
        try:
            password = _saved_password(_storage())
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 503
    if not isinstance(password, str) or not password:
        return jsonify({"error": "Enter a PostgreSQL password or configure POSTGRES_PASSWORD."}), 400
    manager = _storage()
    try:
        result = manager.postgresql.test_connection(normalized, password)
        manager.configuration.mark_connection_success(utc_now())
        return jsonify({
            **result,
            "message": "PostgreSQL connection successful.",
            "warning": None if result["database_exists"] or result["can_create_database"] else (
                "The configured PostgreSQL user cannot create databases. Create the application database manually before initialization."
            ),
        })
    except (PostgreSQLStorageError, RuntimeError) as exc:
        message = str(exc) if isinstance(exc, PostgreSQLStorageError) else "Secure local storage could not be updated."
        return jsonify({"connection_successful": False, "error": message}), 503


@storage_blueprint.post("/storage/postgresql/initialize")
def initialize_postgresql():
    denied = _require_local()
    if denied:
        return denied
    manager = _storage()
    if not acquire_storage_switch():
        return jsonify({"error": "Wait for the running workflow to finish before initializing the database."}), 409
    try:
        try:
            result = manager.postgresql.initialize()
        except ValueError as exc:
            result = {"initialized": False, "message": str(exc)}
            manager.configuration.mark_initialization(result)
            return jsonify(result), 400
        except PostgreSQLStorageError as exc:
            result = {"initialized": False, "message": str(exc)}
            manager.configuration.mark_initialization(result)
            return jsonify(result), 409 if "cannot create databases" in str(exc) or "incompatible" in str(exc) or "newer" in str(exc) else 503
        result["completed_at"] = utc_now()
        manager.configuration.mark_initialization(result)
        manager.configuration.mark_connection_success(result["completed_at"])
    finally:
        release_storage_switch()
    return jsonify(result)


@storage_blueprint.get("/storage/postgresql/schema-status")
def postgresql_schema_status():
    denied = _require_local()
    if denied:
        return denied
    try:
        return jsonify(_storage().postgresql.schema_status())
    except PostgreSQLStorageError as exc:
        return jsonify({"initialized": False, "error": str(exc)}), 503


@storage_blueprint.get("/storage/postgresql/migrations")
def postgresql_migrations():
    denied = _require_local()
    if denied:
        return denied
    try:
        return jsonify({"migrations": _storage().postgresql.list_migrations()})
    except PostgreSQLStorageError as exc:
        return jsonify({"error": str(exc)}), 503


@storage_blueprint.post("/storage/postgresql/activate")
def activate_postgresql():
    denied = _require_local()
    if denied:
        return denied
    manager = _storage()
    try:
        manager.postgresql.test_connection(manager.configuration.postgres, manager.configuration.password)
        schema = manager.postgresql.schema_status()
        if not schema["initialized"]:
            return jsonify({"error": "Initialize the PostgreSQL database before activating it."}), 409
        manager.postgresql.record_counts()
    except (PostgreSQLStorageError, RuntimeError) as exc:
        message = str(exc) if isinstance(exc, PostgreSQLStorageError) else "Storage mode could not be saved."
        return jsonify({"error": message}), 503
    if not acquire_storage_switch():
        return jsonify({"error": "Wait for the running workflow to finish before changing storage modes."}), 409
    try:
        manager.configuration.mark_connection_success(utc_now())
        manager.activate("postgresql")
    except RuntimeError:
        return jsonify({"error": "Storage mode could not be saved."}), 500
    finally:
        release_storage_switch()
    return jsonify({"active_backend": "postgresql", "message": "PostgreSQL is now the active storage backend."})


@storage_blueprint.post("/storage/filesystem/activate")
def activate_filesystem():
    denied = _require_local()
    if denied:
        return denied
    manager = _storage()
    required = (manager.filesystem.uploads_dir, manager.filesystem.processed_dir, manager.filesystem.workflows_dir, manager.filesystem.metadata_dir)
    if not all(path.is_dir() for path in required):
        return jsonify({"error": "File System storage is unavailable."}), 503
    probe = manager.filesystem.root / f".storage-check-{manager.new_id()}.tmp"
    try:
        probe.write_bytes(b"")
        probe.unlink()
    except OSError:
        probe.unlink(missing_ok=True)
        return jsonify({"error": "File System storage is not writable."}), 503
    if not acquire_storage_switch():
        return jsonify({"error": "Wait for the running workflow to finish before changing storage modes."}), 409
    try:
        manager.activate("filesystem")
    except (OSError, RuntimeError):
        return jsonify({"error": "The storage mode could not be saved."}), 500
    finally:
        release_storage_switch()
    return jsonify({
        "active_backend": "filesystem",
        "message": "File System is now the active storage backend.",
    })
