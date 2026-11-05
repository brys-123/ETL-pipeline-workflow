import csv
import io
import json
import zipfile
from math import isfinite
from uuid import uuid4

from flask import Blueprint, current_app, jsonify, request, send_file
from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from ..services.metadata_service import MetadataService
from ..services.dataset_service import DatasetService
from ..services.cleaning_service import CleaningError, apply_cleaning, quality_stats
from ..services.workflow_execution_service import WorkflowExecutionError, cleaning_node, transform_node
from ..utils.file_validator import validate_dataset
from ..utils.helpers import utc_now

files_blueprint = Blueprint("files", __name__)
PREVIEW_ROW_LIMIT = 100
CLEANING_PREVIEW_ROW_LIMIT = 50
MAX_CLEANING_STEPS = 20


def _display_value(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, default=str)
    if isinstance(value, float) and not isfinite(value):
        return str(value)
    if isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _column_names(values):
    return [
        str(value).strip() if value is not None and str(value).strip() else f"Column {index + 1}"
        for index, value in enumerate(values)
    ]


def _preview_json(content):
    value = json.loads(content.decode("utf-8-sig"))
    records = value if isinstance(value, list) else [value]
    if not records:
        return [], [], False

    if all(isinstance(record, dict) for record in records):
        columns = list(dict.fromkeys(str(key) for record in records for key in record))
        rows = [[_display_value(record.get(column, "")) for column in columns] for record in records[:PREVIEW_ROW_LIMIT + 1]]
    elif all(isinstance(record, list) for record in records):
        width = max((len(record) for record in records), default=0)
        columns = _column_names([None] * width)
        rows = [[_display_value(cell) for cell in record] for record in records[:PREVIEW_ROW_LIMIT + 1]]
    else:
        columns = ["Value"]
        rows = [[_display_value(record)] for record in records[:PREVIEW_ROW_LIMIT + 1]]

    has_more = len(rows) > PREVIEW_ROW_LIMIT
    return columns, rows[:PREVIEW_ROW_LIMIT], has_more


def _preview_csv(content):
    text = content.decode("utf-8-sig")
    sample = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample)
    except csv.Error:
        dialect = csv.excel

    reader = csv.reader(io.StringIO(text, newline=""), dialect)
    headers = next(reader, [])
    columns = _column_names(headers)
    rows = []
    for row in reader:
        rows.append([_display_value(cell) for cell in row])
        if len(rows) > PREVIEW_ROW_LIMIT:
            break
    has_more = len(rows) > PREVIEW_ROW_LIMIT
    return columns, rows[:PREVIEW_ROW_LIMIT], has_more


def _preview_excel(content):
    workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    try:
        worksheet = workbook.active
        if worksheet is None:
            return [], [], False
        values = worksheet.iter_rows(values_only=True)
        columns = _column_names(next(values, []))
        rows = []
        for row in values:
            rows.append([_display_value(cell) for cell in row])
            if len(rows) > PREVIEW_ROW_LIMIT:
                break
        has_more = len(rows) > PREVIEW_ROW_LIMIT
        return columns, rows[:PREVIEW_ROW_LIMIT], has_more
    finally:
        workbook.close()


@files_blueprint.get("/files")
def list_files():
    records = MetadataService(current_app.extensions["etl_storage"]).list_files()
    requested_status = request.args.get("status")
    if requested_status:
        records = [record for record in records if record.get("status") == requested_status]
    return jsonify(sorted(records, key=lambda record: record.get("uploaded_at", ""), reverse=True))


@files_blueprint.post("/files/upload")
def upload_file():
    uploaded = request.files.get("file")
    if uploaded is None or not uploaded.filename:
        return jsonify({"error": "Choose a file to upload."}), 400

    max_bytes = int(current_app.config["MAX_UPLOAD_SIZE_MB"]) * 1024 * 1024
    content = uploaded.stream.read(max_bytes + 1)
    if len(content) > max_bytes:
        return jsonify({"error": "File exceeds the configured size limit."}), 413

    try:
        safe_name, extension = validate_dataset(uploaded.filename, content)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    storage = current_app.extensions["etl_storage"]
    metadata = MetadataService(storage)
    file_id = uuid4().hex
    record = {
        "file_id": file_id,
        "filename": safe_name,
        "file_type": extension.removeprefix("."),
        "file_size": len(content),
        "uploaded_at": utc_now(),
        "status": "uploaded",
        "stored_name": f"{file_id}{extension}",
    }
    try:
        storage.write_upload(file_id, extension, content)
        metadata.save_file(record)
    except (OSError, RuntimeError) as exc:
        storage.delete_upload(file_id, extension)
        current_app.logger.exception("Dataset upload failed: %s", exc)
        return jsonify({"error": "The dataset could not be stored."}), 500
    return jsonify(record), 201


@files_blueprint.get("/files/<file_id>/preview")
def preview_file(file_id: str):
    storage = current_app.extensions["etl_storage"]
    record = MetadataService(storage).get_file(file_id)
    if record is None:
        return jsonify({"error": "File not found."}), 404

    try:
        page = request.args.get("page", default=1, type=int)
        page_size = request.args.get("page_size", default=100, type=int)
        query = request.args.get("q", default="", type=str)
        if len(query) > 200:
            return jsonify({"error": "Search text must be 200 characters or fewer."}), 400
        preview = DatasetService(storage).preview(record, page, page_size, query)
        if record.get("file_type") == "csv":
            preview["rows"] = [
                [
                    None if value is None or value != value else str(value)
                    for value in row
                ]
                for row in preview["rows"]
            ]
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError:
        return jsonify({"error": "The stored dataset could not be found."}), 404
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, csv.Error, zipfile.BadZipFile, InvalidFileException) as exc:
        current_app.logger.exception("Dataset preview failed for %s: %s", file_id, exc)
        return jsonify({"error": "The dataset could not be previewed."}), 500

    return jsonify(preview)


def _dataset_inspection(file_id: str):
    storage = current_app.extensions["etl_storage"]
    record = MetadataService(storage).get_file(file_id)
    if record is None:
        return jsonify({"error": "File not found."}), 404
    try:
        return jsonify(DatasetService(storage).inspect(record))
    except FileNotFoundError:
        return jsonify({"error": "The stored dataset could not be found."}), 404
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        current_app.logger.exception("Dataset inspection failed for %s: %s", file_id, exc)
        return jsonify({"error": "The dataset could not be inspected."}), 422


@files_blueprint.get("/files/<file_id>/schema")
def dataset_schema(file_id: str):
    response = _dataset_inspection(file_id)
    if not isinstance(response, tuple):
        return jsonify({"schema": response.json.get("schema", [])})
    return response


@files_blueprint.get("/files/<file_id>/summary")
@files_blueprint.get("/files/<file_id>/statistics")
def dataset_summary(file_id: str):
    return _dataset_inspection(file_id)


def _cleaning_preview_frame(frame, filename: str, file_type: str, page_size: int) -> dict:
    preview = DatasetService.preview_frame(frame, page_size)
    if file_type == "csv":
        preview["rows"] = [
            [None if value is None else str(value) for value in row]
            for row in preview["rows"]
        ]
    return {"filename": filename, **preview}


@files_blueprint.post("/files/<file_id>/clean/preview")
def preview_cleaning(file_id: str):
    storage = current_app.extensions["etl_storage"]
    record = MetadataService(storage).get_file(file_id)
    if record is None:
        return jsonify({"error": "File not found."}), 404

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Cleaning preview settings must be an object."}), 400
    operations = payload.get("operations", [])
    if not isinstance(operations, list) or len(operations) > MAX_CLEANING_STEPS:
        return jsonify({"error": f"Choose no more than {MAX_CLEANING_STEPS} cleaning operations."}), 400
    if any(not isinstance(operation, dict) or not isinstance(operation.get("operation"), str) for operation in operations):
        return jsonify({"error": "Each cleaning step must specify an operation."}), 400

    page_size = payload.get("page_size", CLEANING_PREVIEW_ROW_LIMIT)
    if not isinstance(page_size, int) or isinstance(page_size, bool) or not 1 <= page_size <= CLEANING_PREVIEW_ROW_LIMIT:
        return jsonify({"error": f"Preview row count must be between 1 and {CLEANING_PREVIEW_ROW_LIMIT}."}), 400
    selected_step = payload.get("step", len(operations) - 1)
    if not isinstance(selected_step, int) or isinstance(selected_step, bool) or selected_step < -1 or selected_step >= len(operations):
        if not (not operations and selected_step == -1):
            return jsonify({"error": "Choose a valid cleaning step to preview."}), 400

    try:
        frame = DatasetService(storage).read(record)
        original = frame
        selected_frame = original if selected_step == -1 else None
        stages = []
        for index, config in enumerate(operations):
            frame = transform_node(cleaning_node(config), [frame])
            stats = quality_stats(frame)
            stages.append({
                "step": index,
                "operation": config["operation"],
                **stats,
                "schema": [{"name": str(column), "dtype": str(frame[column].dtype)} for column in frame.columns],
            })
            if index == selected_step:
                selected_frame = frame
        if selected_frame is None:
            selected_frame = frame
        response = {
            "filename": record["filename"],
            "selected_step": selected_step,
            "step_name": operations[selected_step]["operation"] if selected_step >= 0 else None,
            "stages": stages,
            "before": _cleaning_preview_frame(original, record["filename"], record["file_type"], page_size),
            "after": _cleaning_preview_frame(selected_frame, record["filename"], record["file_type"], page_size),
            "before_stats": quality_stats(original),
            "after_stats": quality_stats(selected_frame),
        }
    except (CleaningError, WorkflowExecutionError) as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError:
        return jsonify({"error": "The stored dataset could not be found."}), 404
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        current_app.logger.exception("Cleaning preview failed for %s: %s", file_id, exc)
        return jsonify({"error": "The dataset could not be previewed with these cleaning settings."}), 422
    return jsonify(response)


@files_blueprint.post("/files/<file_id>/clean")
def clean_file(file_id: str):
    storage = current_app.extensions["etl_storage"]
    metadata = MetadataService(storage)
    record = metadata.get_file(file_id)
    if record is None:
        return jsonify({"error": "File not found."}), 404
    processed_id = None
    extension = f".{record['file_type']}"
    try:
        frame = DatasetService(storage).read(record)
        operation = request.get_json(silent=True)
        if isinstance(operation, dict) and "operations" in operation:
            operations = operation["operations"]
            if not isinstance(operations, list) or not operations or len(operations) > MAX_CLEANING_STEPS:
                raise CleaningError(f"Choose between 1 and {MAX_CLEANING_STEPS} cleaning operations.")
            before = quality_stats(frame)
            result = frame
            for config in operations:
                if not isinstance(config, dict) or not isinstance(config.get("operation"), str):
                    raise CleaningError("Each cleaning step must specify an operation.")
                result = transform_node(cleaning_node(config), [result])
            summary = {
                "operation": "sequence",
                "affected_records": abs(before["rows"] - len(result)),
                "before": before,
                "after": quality_stats(result),
                "steps": len(operations),
            }
        elif isinstance(operation, dict) and operation.get("operation") == "filter_rows":
            before = quality_stats(frame)
            result = transform_node(cleaning_node(operation), [frame])
            summary = {
                "operation": "filter_rows",
                "affected_records": len(frame) - len(result),
                "before": before,
                "after": quality_stats(result),
            }
        else:
            result, summary = apply_cleaning(frame, operation)
            if operation.get("operation") == "inspect_outliers":
                return jsonify({"inspection": summary, "quality": quality_stats(frame)})
        processed_id = storage.new_id()
        DatasetService(storage).write_processed(result, extension, processed_id)
        output = {
            "file_id": processed_id,
            "filename": f"cleaned-{record['filename']}",
            "file_type": record["file_type"],
            "file_size": storage.processed_path(processed_id, extension).stat().st_size,
            "uploaded_at": utc_now(),
            "status": "processed",
            "stored_name": f"{processed_id}{extension}",
            "source_file_ids": [file_id],
            "cleaning_summary": summary,
            "row_count": int(len(result)),
            "column_count": int(len(result.columns)),
        }
        metadata.save_file(output)
    except CleaningError as exc:
        if processed_id:
            storage.delete_processed(processed_id, extension)
        return jsonify({"error": str(exc)}), 400
    except WorkflowExecutionError as exc:
        if processed_id:
            storage.delete_processed(processed_id, extension)
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError:
        if processed_id:
            storage.delete_processed(processed_id, extension)
        return jsonify({"error": "The stored dataset could not be found."}), 404
    except (OSError, RuntimeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        if processed_id:
            try:
                storage.delete_processed(processed_id, extension)
            except (OSError, ValueError) as cleanup_error:
                current_app.logger.exception("Could not remove incomplete cleaned dataset %s: %s", processed_id, cleanup_error)
        current_app.logger.exception("Dataset cleaning failed for %s: %s", file_id, exc)
        return jsonify({"error": "The dataset could not be cleaned."}), (500 if isinstance(exc, RuntimeError) else 422)
    return jsonify({"dataset": output, "summary": summary}), 201


@files_blueprint.get("/files/<file_id>/download")
def download_file(file_id: str):
    storage = current_app.extensions["etl_storage"]
    record = MetadataService(storage).get_file(file_id)
    if record is None:
        return jsonify({"error": "File not found."}), 404
    try:
        path = DatasetService(storage).path_for(record)
        return send_file(path, as_attachment=True, download_name=record["filename"], conditional=True)
    except FileNotFoundError:
        return jsonify({"error": "The stored dataset could not be found."}), 404
    except (OSError, ValueError) as exc:
        current_app.logger.exception("Dataset download failed for %s: %s", file_id, exc)
        return jsonify({"error": "The dataset could not be downloaded."}), 500


@files_blueprint.delete("/files/<file_id>")
def delete_file(file_id: str):
    storage = current_app.extensions["etl_storage"]
    metadata = MetadataService(storage)
    record = metadata.get_file(file_id)
    if record is None:
        return jsonify({"error": "File not found."}), 404
    extension = f".{record.get('file_type', '')}"
    try:
        if record.get("status") == "processed":
            storage.delete_processed(file_id, extension)
        else:
            storage.delete_upload(file_id, extension)
        metadata.delete_file(file_id)
    except (OSError, RuntimeError, ValueError) as exc:
        current_app.logger.exception("Dataset deletion failed: %s", exc)
        return jsonify({"error": "The dataset could not be deleted."}), 500
    return jsonify({"deleted": True, "file_id": file_id})