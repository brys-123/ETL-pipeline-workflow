from flask import Blueprint, current_app, jsonify

health_blueprint = Blueprint("health", __name__)


@health_blueprint.get("/health")
def health():
    storage = current_app.extensions["etl_storage"]
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
    return jsonify({
        "status": "ok" if storage_available else "degraded",
        "storage_available": storage_available,
        "storage_mode": current_app.config["STORAGE_MODE"],
        "active_backend": storage.active_backend,
        "max_upload_size_mb": current_app.config["MAX_UPLOAD_SIZE_MB"],
    }), (200 if storage_available else 503)