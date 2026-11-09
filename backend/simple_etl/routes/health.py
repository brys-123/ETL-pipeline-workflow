from flask import Blueprint, current_app, jsonify

health_blueprint = Blueprint("health", __name__)


@health_blueprint.get("/health")
def health():
    storage = current_app.extensions["etl_storage"]
    manager = current_app.extensions["storage_manager"]
    required = (storage.uploads_dir, storage.processed_dir, storage.workflows_dir, storage.logs_dir, storage.metadata_dir)
    filesystem_available = all(path.is_dir() for path in required)
    status = manager.status()
    postgres_unavailable = manager.active_backend == "postgresql" and bool(status["postgresql"]["schema"].get("error"))
    available = filesystem_available and not postgres_unavailable
    return jsonify({
        "status": "ok" if available else "degraded",
        "storage_available": available,
        "storage_mode": current_app.config["STORAGE_MODE"],
        "active_backend": manager.active_backend,
        "filesystem_available": filesystem_available,
        "postgresql": status["postgresql"],
        "error": status["postgresql"]["schema"].get("error") if postgres_unavailable else None,
        "max_upload_size_mb": current_app.config["MAX_UPLOAD_SIZE_MB"],
    }), (200 if available else 503)