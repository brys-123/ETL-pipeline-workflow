from flask import Blueprint, current_app, jsonify

from ..services.metadata_service import MetadataService

dashboard_blueprint = Blueprint("dashboard", __name__)


@dashboard_blueprint.get("/dashboard/stats")
def dashboard_stats():
    metadata = MetadataService(current_app.extensions["etl_storage"])
    files = metadata.list_files()
    workflows = metadata.list_workflows()
    executions = metadata.list_executions()
    activity = [
        {"type": "file", "label": "Dataset uploaded", "name": item["filename"], "timestamp": item["uploaded_at"]}
        for item in files
    ] + [
        {"type": "workflow", "label": "Workflow saved", "name": item["name"], "timestamp": item["updated_at"]}
        for item in workflows
    ]
    activity.sort(key=lambda item: item["timestamp"], reverse=True)
    return jsonify({
        "total_uploaded_files": len(files),
        "processed_datasets": sum(item.get("status") == "processed" for item in files),
        "saved_workflows": len(workflows),
        "completed_executions": sum(item.get("status") == "completed" for item in executions),
        "recent_activity": activity[:8],
    })