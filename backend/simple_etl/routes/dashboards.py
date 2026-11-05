import json
import math

from flask import Blueprint, current_app, jsonify, request

from ..services.metadata_service import MetadataService
from ..utils.helpers import utc_now

dashboards_blueprint = Blueprint("dashboards", __name__)
MAX_DASHBOARD_BYTES = 1_000_000
MAX_DASHBOARD_WIDGETS = 100
MAX_DASHBOARD_DEPTH = 20
MAX_DASHBOARD_ITEMS = 5_000
RESERVED_DASHBOARD_FIELDS = {"dashboard_id", "id", "created_at", "updated_at"}


def _valid_json_value(value, depth=0):
    if depth > MAX_DASHBOARD_DEPTH:
        return False
    if isinstance(value, dict):
        return len(value) <= 100 and all(
            isinstance(key, str) and len(key) <= 200 and _valid_json_value(item, depth + 1)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return len(value) <= MAX_DASHBOARD_ITEMS and all(_valid_json_value(item, depth + 1) for item in value)
    if isinstance(value, str):
        return len(value) <= 10_000
    if isinstance(value, float):
        return math.isfinite(value)
    return value is None or isinstance(value, (bool, int, float))


def validate_dashboard(payload):
    if not isinstance(payload, dict):
        return None, "Dashboard body must be a JSON object."
    if RESERVED_DASHBOARD_FIELDS.intersection(payload):
        return None, "Dashboard identifiers and timestamps are managed by the server."
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
        return None, "Dashboard name is required and must be 120 characters or fewer."
    widgets = payload.get("widgets", [])
    if not isinstance(widgets, list):
        return None, "Dashboard widgets must be an array."
    if len(widgets) > MAX_DASHBOARD_WIDGETS:
        return None, f"Dashboard cannot contain more than {MAX_DASHBOARD_WIDGETS} widgets."
    if not _valid_json_value(payload):
        return None, "Dashboard contains invalid or excessively complex JSON data."
    normalized = dict(payload)
    normalized["name"] = name.strip()
    return normalized, None


def _dashboard_payload():
    if request.content_length is not None and request.content_length > MAX_DASHBOARD_BYTES:
        return None, "Dashboard data exceeds the 1 MB limit."
    raw = request.get_data(cache=True)
    if len(raw) > MAX_DASHBOARD_BYTES:
        return None, "Dashboard data exceeds the 1 MB limit."
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None, "Dashboard body must be valid JSON."
    return validate_dashboard(payload)


@dashboards_blueprint.get("/dashboards")
def list_dashboards():
    return jsonify(MetadataService(current_app.extensions["etl_storage"]).list_dashboards())


@dashboards_blueprint.post("/dashboards")
def create_dashboard():
    normalized, error = _dashboard_payload()
    if error:
        return jsonify({"error": error}), 400
    storage = current_app.extensions["etl_storage"]
    now = utc_now()
    dashboard = {
        "dashboard_id": storage.new_id(),
        **normalized,
        "created_at": now,
        "updated_at": now,
    }
    try:
        MetadataService(storage).save_dashboard(dashboard)
    except (OSError, RuntimeError, ValueError) as exc:
        current_app.logger.exception("Dashboard save failed: %s", exc)
        return jsonify({"error": "The dashboard could not be saved."}), 500
    return jsonify(dashboard), 201


@dashboards_blueprint.get("/dashboards/<dashboard_id>")
def get_dashboard(dashboard_id: str):
    storage = current_app.extensions["etl_storage"]
    if not storage.file_id_is_valid(dashboard_id):
        return jsonify({"error": "Dashboard identifier is invalid."}), 400
    dashboard = MetadataService(storage).get_dashboard(dashboard_id)
    if dashboard is None:
        return jsonify({"error": "Dashboard not found."}), 404
    return jsonify(dashboard)


@dashboards_blueprint.put("/dashboards/<dashboard_id>")
def update_dashboard(dashboard_id: str):
    storage = current_app.extensions["etl_storage"]
    if not storage.file_id_is_valid(dashboard_id):
        return jsonify({"error": "Dashboard identifier is invalid."}), 400
    normalized, error = _dashboard_payload()
    if error:
        return jsonify({"error": error}), 400
    metadata = MetadataService(storage)
    try:
        existing = metadata.get_dashboard(dashboard_id)
        if existing is None:
            return jsonify({"error": "Dashboard not found."}), 404
        dashboard = {
            "dashboard_id": dashboard_id,
            **normalized,
            "created_at": existing["created_at"],
            "updated_at": utc_now(),
        }
        metadata.save_dashboard(dashboard)
    except (OSError, RuntimeError, ValueError) as exc:
        current_app.logger.exception("Dashboard update failed for %s: %s", dashboard_id, exc)
        return jsonify({"error": "The dashboard could not be updated."}), 500
    return jsonify(dashboard)


@dashboards_blueprint.delete("/dashboards/<dashboard_id>")
def delete_dashboard(dashboard_id: str):
    storage = current_app.extensions["etl_storage"]
    if not storage.file_id_is_valid(dashboard_id):
        return jsonify({"error": "Dashboard identifier is invalid."}), 400
    try:
        deleted = MetadataService(storage).delete_dashboard(dashboard_id)
    except (OSError, ValueError) as exc:
        current_app.logger.exception("Dashboard deletion failed for %s: %s", dashboard_id, exc)
        return jsonify({"error": "The dashboard could not be deleted."}), 500
    if not deleted:
        return jsonify({"error": "Dashboard not found."}), 404
    return jsonify({"deleted": True, "dashboard_id": dashboard_id})
