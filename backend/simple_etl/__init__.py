import logging
import os
import secrets
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import click
from flask import Flask, g, jsonify, redirect, send_from_directory
from werkzeug.exceptions import HTTPException
from flask_cors import CORS

from .config import default_config
from .routes import register_routes
from .middleware.authentication import register_authentication_middleware
from .services.auth_service import AuthService
from .services.storage_service import FileSystemStorage
from .services.storage_manager import StorageConfiguration, StorageManager
from .utils.helpers import utc_now


def create_app(overrides: dict[str, Any] | None = None) -> Flask:
    app = Flask(__name__)
    app.config.from_mapping(default_config())
    if overrides:
        app.config.update(overrides)
    if "AUTH_ENABLED" not in (overrides or {}) and app.config.get("TESTING"):
        app.config["AUTH_ENABLED"] = False
    app.config["SECRET_KEY"] = app.config.get("SECRET_KEY") or secrets.token_hex(32)
    if not os.getenv("FLASK_SECRET_KEY") and not os.getenv("SECRET_KEY") and not app.config.get("TESTING"):
        app.logger.warning("FLASK_SECRET_KEY is not configured; configure a stable key to preserve CSRF tokens across restarts.")

    app.config["MAX_CONTENT_LENGTH"] = int(app.config["MAX_UPLOAD_SIZE_MB"]) * 1024 * 1024 + 1024 * 1024
    filesystem = FileSystemStorage(Path(app.config["STORAGE_ROOT"]))
    configuration = StorageConfiguration(filesystem.metadata_dir / "storage_config.json")
    storage = StorageManager(filesystem, configuration)
    app.extensions["etl_storage"] = storage
    storage.write_json(storage.metadata_dir / "settings.json", {
        "storage_mode": app.config["STORAGE_MODE"],
        "max_upload_size_mb": app.config["MAX_UPLOAD_SIZE_MB"],
        "cors_origins": app.config["CORS_ORIGINS"],
        "updated_at": utc_now(),
    })
    app.extensions["etl_storage_manager"] = storage

    CORS(app, resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}}, supports_credentials=True)
    register_authentication_middleware(app)
    register_routes(app)

    frontend_root = Path(app.config["FRONTEND_ROOT"])

    @app.get("/")
    def index():
        return send_from_directory(frontend_root, "index.html")

    @app.get("/login")
    @app.get("/signup")
    @app.get("/forgot-password")
    def authentication_page():
        if g.current_user:
            return redirect("/")
        return send_from_directory(frontend_root, "auth.html")

    @app.get("/logout")
    def logout_page():
        return redirect("/login")

    @app.get("/css/<path:filename>")
    def frontend_css(filename: str):
        return send_from_directory(frontend_root / "css", filename)

    @app.get("/js/<path:filename>")
    def frontend_js(filename: str):
        return send_from_directory(frontend_root / "js", filename)

    @app.get("/vendor/echarts.js")
    def echarts_vendor():
        return send_from_directory(frontend_root / "node_modules" / "echarts" / "dist", "echarts.min.js")

    @app.get("/vendor/html-to-image.js")
    def html_to_image_vendor():
        return send_from_directory(frontend_root / "node_modules" / "html-to-image" / "dist", "html-to-image.js")

    @app.cli.command("create-admin")
    @click.option("--username", prompt=True)
    @click.option("--email", prompt=True)
    @click.option("--full-name", prompt=True)
    def create_admin(username: str, email: str, full_name: str):
        service = AuthService(app.extensions["etl_storage"])
        existing = service.get_user_by_identity(username)
        if existing is None:
            existing = service.get_user_by_identity(email)
        if existing is None:
            password = click.prompt("Password", hide_input=True, confirmation_prompt=True)
            if not (
                12 <= len(password) <= 128
                and any(char.islower() for char in password)
                and any(char.isupper() for char in password)
                and any(char.isdigit() for char in password)
            ):
                raise click.ClickException("Password must be 12–128 characters and include uppercase, lowercase, and a number.")
            try:
                existing = service.create_user(
                    full_name=full_name,
                    username=username,
                    email=email,
                    password=password,
                    role="admin",
                )
            except (OSError, RuntimeError, ValueError) as exc:
                raise click.ClickException(str(exc)) from exc
        else:
            existing["role"] = "admin"
            existing["status"] = "active"
            service.save_user(existing)
        click.echo(f"Administrator account ready: {existing['username']}")

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