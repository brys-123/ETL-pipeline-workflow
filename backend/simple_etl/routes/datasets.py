import csv
import json
import zipfile

from flask import Blueprint, current_app, jsonify, request
from openpyxl.utils.exceptions import InvalidFileException

from ..services.dataset_service import DatasetService
from ..services.metadata_service import MetadataService

datasets_blueprint = Blueprint("datasets", __name__)


def _dataset_record(dataset_id: str):
    storage = current_app.extensions["etl_storage"]
    if not storage.file_id_is_valid(dataset_id):
        return None, (jsonify({"error": "Dataset identifier is invalid."}), 400)

    record = MetadataService(storage).get_file(dataset_id)
    if record is None or record.get("status") not in {"uploaded", "processed"}:
        return None, (jsonify({"error": "Dataset not found."}), 404)
    return record, None


@datasets_blueprint.get("/datasets")
def list_datasets():
    storage = current_app.extensions["etl_storage"]
    records = MetadataService(storage).list_files()
    source = request.args.get("source", "all").strip().casefold()
    datasets = [
        record for record in records
        if record.get("status") in {"uploaded", "processed"}
        and isinstance(record.get("file_id"), str)
        and storage.file_id_is_valid(record["file_id"])
    ]
    if source in {"imported", "uploaded"}:
        datasets = [record for record in datasets if record.get("status") == "uploaded"]
    elif source in {"processed", "saved"}:
        datasets = [record for record in datasets if record.get("status") == "processed"]
    dataset_service = DatasetService(storage)
    discovered = []
    for record in datasets:
        item = dict(record)
        item.setdefault("dataset_id", record.get("dataset_id") or record.get("file_id"))
        item["source_type"] = item.get("source_type") or ("processed" if item.get("status") == "processed" else "imported")
        try:
            inspection = dataset_service.inspect(record)
            item["rows"] = inspection["rows"]
            item["column_count"] = inspection["columns"]
        except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            current_app.logger.exception("Dataset discovery failed for %s: %s", record["file_id"], exc)
            item["rows"] = record.get("row_count", 0)
            item["column_count"] = record.get("column_count", 0)
        discovered.append(item)
    return jsonify(sorted(discovered, key=lambda record: record.get("uploaded_at", ""), reverse=True))


@datasets_blueprint.get("/datasets/<dataset_id>")
def get_dataset(dataset_id: str):
    storage = current_app.extensions["etl_storage"]
    record = MetadataService(storage).get_file(dataset_id)
    if record is None:
        return jsonify({"error": "Dataset not found."}), 404
    item = dict(record)
    item.setdefault("dataset_id", item.get("dataset_id") or dataset_id)
    item["source_type"] = item.get("source_type") or ("processed" if item.get("status") == "processed" else "imported")
    return jsonify(item)


@datasets_blueprint.get("/datasets/<dataset_id>/schema")
def dataset_schema(dataset_id: str):
    record, error_response = _dataset_record(dataset_id)
    if error_response:
        return error_response
    try:
        inspection = DatasetService(current_app.extensions["etl_storage"]).inspect(record)
    except FileNotFoundError:
        return jsonify({"error": "The stored dataset could not be found."}), 404
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        current_app.logger.exception("Dataset schema lookup failed for %s: %s", dataset_id, exc)
        return jsonify({"error": "The dataset schema could not be read."}), 422
    return jsonify(inspection)


@datasets_blueprint.get("/datasets/<dataset_id>/refresh")
@datasets_blueprint.post("/datasets/<dataset_id>/refresh")
def dataset_refresh(dataset_id: str):
    record, error_response = _dataset_record(dataset_id)
    if error_response:
        return error_response
    try:
        inspection = DatasetService(current_app.extensions["etl_storage"]).inspect(record)
        refreshed = dict(record)
        refreshed["dataset_id"] = refreshed.get("dataset_id") or dataset_id
        refreshed["source_type"] = refreshed.get("source_type") or ("processed" if refreshed.get("status") == "processed" else "imported")
        refreshed["last_updated"] = refreshed.get("last_updated") or refreshed.get("updated_at") or refreshed.get("uploaded_at")
        refreshed["rows"] = inspection["rows"]
        refreshed["column_count"] = inspection["columns"]
        MetadataService(current_app.extensions["etl_storage"]).save_file(refreshed)
        return jsonify({"dataset": refreshed, "inspection": inspection})
    except FileNotFoundError:
        return jsonify({"error": "The stored dataset could not be found."}), 404
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        current_app.logger.exception("Dataset refresh failed for %s: %s", dataset_id, exc)
        return jsonify({"error": "The dataset could not be refreshed."}), 422


@datasets_blueprint.get("/datasets/<dataset_id>/preview")
def dataset_preview(dataset_id: str):
    record, error_response = _dataset_record(dataset_id)
    if error_response:
        return error_response
    page = request.args.get("page", default=1, type=int)
    page_size = request.args.get("page_size", default=100, type=int)
    query = request.args.get("q", default="", type=str)
    if len(query) > 200:
        return jsonify({"error": "Search text must be 200 characters or fewer."}), 400
    try:
        preview = DatasetService(current_app.extensions["etl_storage"]).preview(record, page, page_size, query)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError:
        return jsonify({"error": "The stored dataset could not be found."}), 404
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, csv.Error, zipfile.BadZipFile, InvalidFileException) as exc:
        current_app.logger.exception("Dataset preview failed for %s: %s", dataset_id, exc)
        return jsonify({"error": "The dataset could not be previewed."}), 500
    return jsonify(preview)
