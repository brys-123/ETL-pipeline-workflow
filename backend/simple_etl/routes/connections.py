from __future__ import annotations

import hmac
from functools import wraps

from flask import Blueprint, current_app, jsonify, request

from ..services.connection_manager import (
    ConnectionConfigurationError,
    ConnectionManager,
)
from ..services.external_sources import ExternalSourceError, ExternalSourceService
from ..services.storage_manager import StorageUnavailableError
from ..services.dataset_service import DatasetService

connections_blueprint = Blueprint("connections", __name__)


def _manager() -> ConnectionManager:
    return ConnectionManager(current_app.extensions["etl_storage"])


def _authorized(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        expected = current_app.config.get("CONNECTIONS_API_TOKEN", "")
        if not expected:
            return jsonify({"error": "External connections are disabled until CONNECTIONS_API_TOKEN is configured."}), 503
        supplied = request.headers.get("Authorization", "")
        if not supplied.startswith("Bearer ") or not hmac.compare_digest(supplied[7:], expected):
            return jsonify({"error": "A valid connection access token is required."}), 401
        return view(*args, **kwargs)
    return wrapped


def _error(error: Exception):
    if isinstance(error, ConnectionConfigurationError):
        return jsonify({"error": str(error)}), 400
    if isinstance(error, ExternalSourceError):
        return jsonify({"error": str(error)}), 422
    if isinstance(error, StorageUnavailableError):
        return jsonify({"error": str(error)}), 503
    return jsonify({"error": "The external connection operation could not be completed."}), 500


def _connection_and_secrets(payload: dict):
    manager = _manager()
    connection_id = payload.get("connection_id")
    if connection_id:
        saved, secrets = manager.get_with_secrets(connection_id)
        if len(payload) > 1:
            connection, supplied_secrets = manager.normalize(payload, saved)
            secrets.update(supplied_secrets)
            return connection, secrets
        return saved, secrets
    connection, secrets = manager.normalize(payload)
    return connection, secrets


@connections_blueprint.get("/connections")
@_authorized
def list_connections():
    manager = _manager()
    records = manager.list()
    try:
        keyring = manager._keyring()
        return jsonify([
            {
                **record,
                "secret_configured": keyring.get_password(
                    "simple-etl-studio-external-connections", record["connection_id"],
                ) is not None,
            }
            for record in records
        ])
    except Exception as exc:
        return _error(exc)


@connections_blueprint.post("/connections")
@_authorized
def create_connection():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Connection details must be an object."}), 400
    try:
        return jsonify(_manager().save(payload)), 201
    except Exception as exc:
        return _error(exc)


@connections_blueprint.put("/connections/<connection_id>")
@_authorized
def update_connection(connection_id: str):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Connection details must be an object."}), 400
    try:
        return jsonify(_manager().save(payload, connection_id)), 200
    except Exception as exc:
        return _error(exc)


@connections_blueprint.delete("/connections/<connection_id>")
@_authorized
def delete_connection(connection_id: str):
    try:
        if not _manager().delete(connection_id):
            return jsonify({"error": "Saved connection was not found."}), 404
        return jsonify({"deleted": True})
    except Exception as exc:
        return _error(exc)


@connections_blueprint.post("/connections/test")
@_authorized
def test_connection():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Connection details must be an object."}), 400
    try:
        connection, secrets = _connection_and_secrets(payload)
        return jsonify(ExternalSourceService().test(connection, secrets))
    except Exception as exc:
        return _error(exc)


@connections_blueprint.get("/connections/<connection_id>/tables")
@_authorized
def list_tables(connection_id: str):
    try:
        connection, secrets = _manager().get_with_secrets(connection_id)
        schema = request.args.get("schema")
        if schema is not None and (len(schema) > 128 or not schema.strip()):
            return jsonify({"error": "Choose a valid PostgreSQL schema."}), 400
        return jsonify(ExternalSourceService().tables(connection, secrets, schema))
    except Exception as exc:
        return _error(exc)


@connections_blueprint.post("/connections/<connection_id>/preview")
@_authorized
def preview_connection(connection_id: str):
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "Preview settings must be an object."}), 400
    try:
        connection, secrets = _manager().get_with_secrets(connection_id)
        frame, metrics = ExternalSourceService().extract(connection, secrets, payload, row_limit=100, allow_truncate=True)
        preview = DatasetService.preview_frame(frame, 100)
        return jsonify({**preview, **metrics})
    except Exception as exc:
        return _error(exc)