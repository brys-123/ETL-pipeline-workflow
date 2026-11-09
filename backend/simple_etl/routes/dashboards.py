import json
import math

from flask import Blueprint, current_app, jsonify, request

from ..services.dataset_service import DatasetService
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


@dashboards_blueprint.get("/dashboards/<dashboard_id>/data")
def dashboard_data(dashboard_id: str):
    storage = current_app.extensions["etl_storage"]
    if not storage.file_id_is_valid(dashboard_id):
        return jsonify({"error": "Dashboard identifier is invalid."}), 400
    dashboard = MetadataService(storage).get_dashboard(dashboard_id)
    if dashboard is None:
        return jsonify({"error": "Dashboard not found."}), 404
    dataset_id = dashboard.get("dataset_id") or dashboard.get("dataset") or dashboard.get("data_source")
    if not dataset_id:
        return jsonify({"error": "This dashboard has no dataset selected."}), 400
    dataset = MetadataService(storage).get_file(dataset_id)
    if dataset is None:
        return jsonify({"error": "The dashboard dataset could not be found."}), 404
    try:
        datasets = DatasetService(storage)
        preview = datasets.preview(dataset, 1, 100)
        rows = list(preview["rows"])
        for page in range(2, min(preview["total_pages"], 10) + 1):
            rows.extend(datasets.preview(dataset, page, 100)["rows"])
        preview["rows"] = rows
        preview["page_size"] = len(rows)
        preview["page"] = 1
        preview["total_pages"] = 1
        preview["has_more"] = len(rows) < preview["total_rows"]
        return jsonify({
            "dashboard_id": dashboard_id,
            "dataset_id": dataset_id,
            "dataset_name": dataset.get("filename"),
            "source_type": dataset.get("source_type") or ("processed" if dataset.get("status") == "processed" else "imported"),
            "preview": preview,
            "rows": rows,
            "columns": preview.get("columns", []),
        })
    except (OSError, ValueError, TypeError, UnicodeDecodeError) as exc:
        current_app.logger.exception("Dashboard data refresh failed for %s: %s", dashboard_id, exc)
        return jsonify({"error": "The dashboard dataset could not be loaded."}), 422


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
    except (OSError, RuntimeError, ValueError) as exc:
        current_app.logger.exception("Dashboard deletion failed for %s: %s", dashboard_id, exc)
        return jsonify({"error": "The dashboard could not be deleted."}), 500
    if not deleted:
        return jsonify({"error": "Dashboard not found."}), 404
    return jsonify({"deleted": True, "dashboard_id": dashboard_id})


@dashboards_blueprint.post("/dashboards/delete-selected")
def delete_selected_dashboards():
    payload = request.get_json(silent=True) or {}
    dashboard_ids = payload.get("dashboard_ids")
    if not isinstance(dashboard_ids, list) or not dashboard_ids or len(dashboard_ids) > 500:
        return jsonify({"error": "Select between 1 and 500 dashboards to delete."}), 400
    storage = current_app.extensions["etl_storage"]
    if any(not isinstance(dashboard_id, str) or not storage.file_id_is_valid(dashboard_id) for dashboard_id in dashboard_ids):
        return jsonify({"error": "One or more dashboard identifiers are invalid."}), 400
    metadata = MetadataService(storage)
    deleted = []
    failed = []
    for dashboard_id in dict.fromkeys(dashboard_ids):
        try:
            if metadata.delete_dashboard(dashboard_id):
                deleted.append({"dashboard_id": dashboard_id})
            else:
                failed.append({"dashboard_id": dashboard_id, "error": "Dashboard not found."})
        except (OSError, RuntimeError, ValueError) as exc:
            current_app.logger.exception("Dashboard deletion failed for %s: %s", dashboard_id, exc)
            failed.append({"dashboard_id": dashboard_id, "error": "The dashboard could not be deleted."})
    current_app.logger.info("Deleted %s dashboard definition(s); referenced datasets were retained.", len(deleted))
    return jsonify({
        "deleted": deleted,
        "failed": failed,
        "deleted_count": len(deleted),
        "partial": bool(failed),
        "datasets_preserved": True,
    })
