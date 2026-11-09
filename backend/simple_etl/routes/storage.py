from flask import Blueprint, current_app, jsonify, request

from ..services.metadata_service import MetadataService
from ..services.postgres_schema import MIGRATIONS
from ..services.storage_manager import StorageConfigurationError, StorageUnavailableError

storage_blueprint = Blueprint("storage", __name__)


def _manager():
    return current_app.extensions["storage_manager"]


def _failure(error: Exception):
    if isinstance(error, StorageConfigurationError):
        status = 400
        if "cannot create databases" in str(error):
            status = 403
    elif isinstance(error, StorageUnavailableError):
        status = 503
    else:
        current_app.logger.exception("Storage configuration operation failed: %s", error)
        return jsonify({"error": "The storage operation could not be completed."}), 500
    return jsonify({"error": str(error)}), status


@storage_blueprint.get("/storage/status")
def storage_status():
    manager = _manager()
    result = manager.status()
    result["storage_mode"] = current_app.config["STORAGE_MODE"]
    result["max_upload_size_mb"] = current_app.config["MAX_UPLOAD_SIZE_MB"]
    try:
        metadata = MetadataService(current_app.extensions["etl_storage"])
        records = metadata.list_files()
        workflows = metadata.list_workflows()
        dashboards = metadata.list_dashboards()
        executions = metadata.list_executions()
        result["record_counts"] = {
            "total_files": len(records),
            "uploaded_datasets": sum(item.get("status") == "uploaded" for item in records),
            "processed_datasets": sum(item.get("status") == "processed" for item in records),
            "workflows": len(workflows),
            "dashboards": len(dashboards),
            "executions": len(executions),
            "total_records": len(records) + len(workflows) + len(dashboards) + len(executions),
        }
        result["storage_health"] = "available" if manager.active_backend == "filesystem" or not result["postgresql"]["schema"].get("error") else "unavailable"
    except StorageUnavailableError as exc:
        result["record_counts"] = None
        result["storage_health"] = "unavailable"
        result["error"] = str(exc)
        return jsonify(result), 503
    return jsonify(result)


@storage_blueprint.get("/storage/config")
def storage_config():
    return jsonify(_manager().configuration_response())


@storage_blueprint.post("/storage/config")
def save_storage_config():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Storage configuration must be a JSON object."}), 400
    try:
        return jsonify(_manager().save_postgresql_config(payload))
    except (StorageConfigurationError, StorageUnavailableError) as exc:
        return _failure(exc)


@storage_blueprint.post("/storage/postgresql/test-connection")
def test_postgresql_connection():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "PostgreSQL connection settings must be an object."}), 400
    try:
        return jsonify(_manager().test_postgresql_connection(payload))
    except (StorageConfigurationError, StorageUnavailableError) as exc:
        return _failure(exc)


@storage_blueprint.post("/storage/postgresql/initialize")
def initialize_postgresql():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "PostgreSQL initialization settings must be an object."}), 400
    try:
        return jsonify(_manager().initialize_postgresql(payload))
    except (StorageConfigurationError, StorageUnavailableError) as exc:
        return _failure(exc)
    except Exception as exc:
        from ..services.postgres_schema import IncompatibleSchemaError

        if isinstance(exc, IncompatibleSchemaError):
            return jsonify({"error": str(exc)}), 409
        return _failure(exc)


@storage_blueprint.get("/storage/postgresql/schema-status")
def postgresql_schema_status():
    return jsonify(_manager().get_postgresql_schema_status())


@storage_blueprint.get("/storage/postgresql/migrations")
def postgresql_migrations():
    status = _manager().get_postgresql_schema_status()
    return jsonify({"available": list(MIGRATIONS), "applied": status.get("migrations", []), "schema_version": status.get("schema_version"), "initialized": status.get("initialized", False), "error": status.get("error")})


@storage_blueprint.post("/storage/postgresql/activate")
def activate_postgresql():
    try:
        return jsonify(_manager().activate_postgresql())
    except (StorageConfigurationError, StorageUnavailableError) as exc:
        return _failure(exc)


@storage_blueprint.post("/storage/filesystem/activate")
def activate_filesystem():
    try:
        return jsonify(_manager().activate_filesystem())
    except (StorageConfigurationError, StorageUnavailableError) as exc:
        return _failure(exc)