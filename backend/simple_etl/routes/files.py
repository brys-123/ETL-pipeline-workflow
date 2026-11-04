from pathlib import Path
from uuid import uuid4

from flask import Blueprint, current_app, jsonify, request

from ..services.metadata_service import MetadataService
from ..utils.file_validator import validate_dataset
from ..utils.helpers import utc_now

files_blueprint = Blueprint("files", __name__)


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


@files_blueprint.delete("/files/<file_id>")
def delete_file(file_id: str):
    storage = current_app.extensions["etl_storage"]
    metadata = MetadataService(storage)
    record = metadata.get_file(file_id)
    if record is None:
        return jsonify({"error": "File not found."}), 404
    extension = f".{record.get('file_type', '')}"
    try:
        storage.delete_upload(file_id, extension)
        metadata.delete_file(file_id)
    except (OSError, RuntimeError, ValueError) as exc:
        current_app.logger.exception("Dataset deletion failed: %s", exc)
        return jsonify({"error": "The dataset could not be deleted."}), 500
    return jsonify({"deleted": True, "file_id": file_id})