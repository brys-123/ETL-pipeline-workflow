import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, send_from_directory
from werkzeug.exceptions import HTTPException
from flask_cors import CORS

from .config import default_config
from .routes import register_routes
from .services.storage_service import FileSystemStorage
from .utils.helpers import utc_now


def create_app(overrides: dict[str, Any] | None = None) -> Flask:
    app = Flask(__name__)
    app.config.from_mapping(default_config())
    if overrides:
        app.config.update(overrides)

    app.config["MAX_CONTENT_LENGTH"] = int(app.config["MAX_UPLOAD_SIZE_MB"]) * 1024 * 1024 + 1024 * 1024
    storage = FileSystemStorage(Path(app.config["STORAGE_ROOT"]))
    app.extensions["etl_storage"] = storage
    storage.write_json(storage.metadata_dir / "settings.json", {
        "storage_mode": app.config["STORAGE_MODE"],
        "max_upload_size_mb": app.config["MAX_UPLOAD_SIZE_MB"],
        "cors_origins": app.config["CORS_ORIGINS"],
        "updated_at": utc_now(),
    })

    CORS(app, resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}})
    register_routes(app)

    frontend_root = Path(app.config["FRONTEND_ROOT"])

    @app.get("/")
    def index():
        return send_from_directory(frontend_root, "index.html")

    @app.get("/css/<path:filename>")
    def frontend_css(filename: str):
        return send_from_directory(frontend_root / "css", filename)

    @app.get("/js/<path:filename>")
    def frontend_js(filename: str):
        return send_from_directory(frontend_root / "js", filename)

    @app.errorhandler(413)
    def too_large(_error):
        return jsonify({"error": "Upload exceeds the configured size limit."}), 413

    @app.errorhandler(Exception)
    def handle_unexpected_error(error):
        if isinstance(error, HTTPException):
            return error
        app.logger.exception("Unhandled application error: %s", error)
        return jsonify({"error": "An unexpected server error occurred."}), 500

    log_path = storage.logs_dir / "app.log"
    if not any(getattr(handler, "baseFilename", None) == str(log_path.resolve()) for handler in app.logger.handlers):
        handler = RotatingFileHandler(log_path, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        app.logger.addHandler(handler)
    app.logger.setLevel(logging.INFO)
    return app