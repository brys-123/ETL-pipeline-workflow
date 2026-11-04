from flask import Blueprint, current_app, jsonify

health_blueprint = Blueprint("health", __name__)


@health_blueprint.get("/health")
def health():
    storage = current_app.extensions["etl_storage"]
    required = (storage.uploads_dir, storage.processed_dir, storage.workflows_dir, storage.logs_dir, storage.metadata_dir)
    available = all(path.is_dir() for path in required)
    return jsonify({
        "status": "ok" if available else "degraded",
        "storage_available": available,
        "storage_mode": current_app.config["STORAGE_MODE"],
        "max_upload_size_mb": current_app.config["MAX_UPLOAD_SIZE_MB"],
    }), (200 if available else 503)