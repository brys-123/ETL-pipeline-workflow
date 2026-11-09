from flask import Blueprint, current_app, jsonify

health_blueprint = Blueprint("health", __name__)


@health_blueprint.get("/health")
def health():
    storage = current_app.extensions["etl_storage"]
<<<<<<< HEAD
    manager = current_app.extensions["storage_manager"]
    required = (storage.uploads_dir, storage.processed_dir, storage.workflows_dir, storage.logs_dir, storage.metadata_dir)
    filesystem_available = all(path.is_dir() for path in required)
    status = manager.status()
    postgres_unavailable = manager.active_backend == "postgresql" and bool(status["postgresql"]["schema"].get("error"))
    available = filesystem_available and not postgres_unavailable
=======
    filesystem = storage.filesystem
    required = (filesystem.uploads_dir, filesystem.processed_dir, filesystem.workflows_dir, filesystem.logs_dir, filesystem.metadata_dir)
    available = all(path.is_dir() for path in required)
    if storage.active_backend == "postgresql":
        try:
            storage.postgresql.schema_status()
            storage_available = True
        except RuntimeError:
            storage_available = False
    else:
        storage_available = available
>>>>>>> cabfcff74dd1bdc17781142a1c5b05739a95b821
    return jsonify({
        "status": "ok" if storage_available else "degraded",
        "storage_available": storage_available,
        "storage_mode": current_app.config["STORAGE_MODE"],
<<<<<<< HEAD
        "active_backend": manager.active_backend,
        "filesystem_available": filesystem_available,
        "postgresql": status["postgresql"],
        "error": status["postgresql"]["schema"].get("error") if postgres_unavailable else None,
=======
        "active_backend": storage.active_backend,
>>>>>>> cabfcff74dd1bdc17781142a1c5b05739a95b821
        "max_upload_size_mb": current_app.config["MAX_UPLOAD_SIZE_MB"],
    }), (200 if storage_available else 503)