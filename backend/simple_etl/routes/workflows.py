import math
from flask import Blueprint, current_app, jsonify, request

from ..services.metadata_service import MetadataService
from ..services.dataset_service import DatasetService
from ..utils.helpers import utc_now
from ..services.workflow_execution_service import WorkflowExecutionError, WorkflowExecutionService

workflows_blueprint = Blueprint("workflows", __name__)


def validate_workflow(payload: object) -> tuple[dict | None, str | None]:
    if not isinstance(payload, dict):
        return None, "Workflow body must be a JSON object."
    name = payload.get("name")
    nodes = payload.get("nodes", [])
    edges = payload.get("edges", [])
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
        return None, "Workflow name is required and must be 120 characters or fewer."
    if not isinstance(nodes, list) or not isinstance(edges, list):
        return None, "Workflow nodes and edges must be arrays."
    if len(nodes) > 250 or len(edges) > 500:
        return None, "Workflow exceeds the node or connection limit."

    node_ids: set[str] = set()
    normalized_nodes = []
    for node in nodes:
        if not isinstance(node, dict):
            return None, "Every workflow node must be an object."
        node_id, node_type = node.get("id"), node.get("type")
        if not isinstance(node_id, str) or not node_id or len(node_id) > 100 or node_id in node_ids:
            return None, "Workflow node identifiers must be unique non-empty strings."
        if not isinstance(node_type, str) or len(node_type) > 60:
            return None, "Every workflow node must have a valid type."
        label = node.get("name", node_type.replace("_", " ").title())
        if not isinstance(label, str) or not label.strip() or len(label) > 120:
            return None, "Workflow node names must be non-empty and 120 characters or fewer."
        position = node.get("position", {})
        if not isinstance(position, dict):
            return None, "Workflow node positions must be objects."
        x, y = position.get("x", 0), position.get("y", 0)
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 100_000 for value in (x, y)):
            return None, "Workflow node coordinates must be finite numbers within the canvas limit."
        config = node.get("config", {})
        if not isinstance(config, dict):
            return None, "Workflow node configuration must be an object."
        description = node.get("description", "")
        if not isinstance(description, str):
            return None, "Workflow node descriptions must be text."
        node_ids.add(node_id)
        normalized_nodes.append({
            "id": node_id,
            "type": node_type,
            "name": label.strip(),
            "description": description[:300],
            "position": {"x": x, "y": y},
            "config": config,
        })

    normalized_edges = []
    edge_ids: set[str] = set()
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            return None, "Every workflow connection must be an object."
        source, target = edge.get("source"), edge.get("target")
        if not isinstance(source, str) or not isinstance(target, str) or source not in node_ids or target not in node_ids or source == target:
            return None, "Workflow connections must join two different existing nodes."
        edge_id = edge.get("id", f"edge-{index + 1}")
        if not isinstance(edge_id, str) or not edge_id or edge_id in edge_ids:
            return None, "Workflow connection identifiers must be unique strings."
        edge_ids.add(edge_id)
        normalized_edges.append({"id": edge_id, "source": source, "target": target})

    return {"name": name.strip(), "nodes": normalized_nodes, "edges": normalized_edges}, None


@workflows_blueprint.get("/workflows")
def list_workflows():
    return jsonify(MetadataService(current_app.extensions["etl_storage"]).list_workflows())


@workflows_blueprint.post("/workflows")
def save_workflow():
    normalized, error = validate_workflow(request.get_json(silent=True))
    if error:
        return jsonify({"error": error}), 400
    metadata = MetadataService(current_app.extensions["etl_storage"])
    workflow_id = request.get_json().get("workflow_id")
    existing = None
    if workflow_id is not None:
        if not isinstance(workflow_id, str):
            return jsonify({"error": "Workflow identifier is invalid."}), 400
        try:
            existing = metadata.get_workflow(workflow_id)
        except ValueError:
            return jsonify({"error": "Workflow identifier is invalid."}), 400
        if existing is None:
            return jsonify({"error": "Workflow not found."}), 404
    now = utc_now()
    workflow = {
        "workflow_id": workflow_id or current_app.extensions["etl_storage"].new_id(),
        **normalized,
        "created_at": existing["created_at"] if existing else now,
        "updated_at": now,
    }
    try:
        metadata.save_workflow(workflow)
    except (OSError, RuntimeError, ValueError) as exc:
        current_app.logger.exception("Workflow save failed: %s", exc)
        return jsonify({"error": "The workflow could not be saved."}), 500
    return jsonify(workflow), (200 if existing else 201)


@workflows_blueprint.get("/workflows/<workflow_id>")
def get_workflow(workflow_id: str):
    try:
        workflow = MetadataService(current_app.extensions["etl_storage"]).get_workflow(workflow_id)
    except ValueError:
        workflow = None
    if workflow is None:
        return jsonify({"error": "Workflow not found."}), 404
    return jsonify(workflow)


@workflows_blueprint.post("/workflows/<workflow_id>/validate")
def validate_saved_workflow(workflow_id: str):
    metadata = MetadataService(current_app.extensions["etl_storage"])
    try:
        workflow = metadata.get_workflow(workflow_id)
    except ValueError:
        workflow = None
    if workflow is None:
        return jsonify({"error": "Workflow not found."}), 404
    result = WorkflowExecutionService(current_app.extensions["etl_storage"]).validate(workflow)
    return jsonify(result), (200 if result["valid"] else 400)


@workflows_blueprint.post("/workflows/<workflow_id>/run")
def start_workflow_execution(workflow_id: str):
    metadata = MetadataService(current_app.extensions["etl_storage"])
    try:
        workflow = metadata.get_workflow(workflow_id)
    except ValueError:
        workflow = None
    if workflow is None:
        return jsonify({"error": "Workflow not found."}), 404
    try:
        result = WorkflowExecutionService(current_app.extensions["etl_storage"]).start(workflow)
    except WorkflowExecutionError as exc:
        return jsonify({
            "error": str(exc),
            "failing_node_id": exc.node_id,
            "errors": str(exc).removeprefix("Workflow validation failed: ").split(". "),
        }), (409 if "currently executing" in str(exc) else 422)
    except (OSError, RuntimeError, ValueError) as exc:
        current_app.logger.exception("Workflow execution could not be started for %s: %s", workflow_id, exc)
        return jsonify({"error": "Workflow execution could not be started."}), 500
    return jsonify(result), 202


@workflows_blueprint.post("/workflows/<workflow_id>/save-output")
def save_workflow_output(workflow_id: str):
    metadata = MetadataService(current_app.extensions["etl_storage"])
    try:
        workflow = metadata.get_workflow(workflow_id)
    except ValueError:
        workflow = None
    if workflow is None:
        return jsonify({"error": "Workflow not found."}), 404
    payload = request.get_json(silent=True) or {}
    node_id = payload.get("node_id")
    if not isinstance(node_id, str) or not node_id:
        outputs = [node for node in workflow.get("nodes", []) if node.get("type") in {"csv_output", "excel_output", "json_output"}]
        if not outputs:
            return jsonify({"error": "The workflow has no output node to save."}), 400
        node_id = outputs[0]["id"]
    dataset_id = metadata.stable_dataset_id(workflow_id, node_id)
    filename = payload.get("filename") or next(
        (node.get("config", {}).get("filename") for node in workflow.get("nodes", []) if node.get("id") == node_id),
        "workflow-output",
    )
    record = {
        "file_id": dataset_id,
        "dataset_id": dataset_id,
        "filename": filename,
        "file_type": payload.get("file_type") or "csv",
        "file_size": payload.get("file_size", 0),
        "uploaded_at": utc_now(),
        "last_updated": utc_now(),
        "status": "processed",
        "stored_name": f"{dataset_id}.{(payload.get('file_type') or 'csv')}",
        "source_type": "processed",
        "workflow_id": workflow_id,
        "output_node_id": node_id,
        "dataset_version": 1,
    }
    metadata.save_file(record)
    return jsonify({"dataset": record, "dataset_id": dataset_id})


@workflows_blueprint.post("/workflows/<workflow_id>/execute")
def execute_saved_workflow(workflow_id: str):
    metadata = MetadataService(current_app.extensions["etl_storage"])
    try:
        workflow = metadata.get_workflow(workflow_id)
    except ValueError:
        workflow = None
    if workflow is None:
        return jsonify({"error": "Workflow not found."}), 404
    try:
        result = WorkflowExecutionService(current_app.extensions["etl_storage"]).execute(workflow)
    except WorkflowExecutionError as exc:
        current_app.logger.info("Workflow %s execution rejected/failed: %s", workflow_id, exc)
        failed = next(
            (item for item in reversed(metadata.list_executions()) if item.get("workflow_id") == workflow_id and item.get("status") == "failed"),
            None,
        )
        return jsonify({
            "error": str(exc),
            "execution": failed,
            "failing_node_id": exc.node_id or (failed or {}).get("failing_node_id"),
        }), (409 if "currently executing" in str(exc) else 422)
    except (OSError, RuntimeError, ValueError) as exc:
        current_app.logger.exception("Workflow execution failed for %s: %s", workflow_id, exc)
        return jsonify({"error": "The workflow could not be executed."}), 500
    return jsonify(result)


@workflows_blueprint.get("/executions")
def list_executions():
    metadata = MetadataService(current_app.extensions["etl_storage"])
    executions = metadata.list_executions()
    status = request.args.get("status")
    workflow_id = request.args.get("workflow_id")
    query = request.args.get("q", "").strip().casefold()
    if status and status not in {"running", "completed", "failed"}:
        return jsonify({"error": "Choose running, completed, or failed as the status filter."}), 400
    if len(query) > 120:
        return jsonify({"error": "Search text must be 120 characters or fewer."}), 400
    if status:
        executions = [item for item in executions if item.get("status") == status]
    if workflow_id:
        executions = [item for item in executions if item.get("workflow_id") == workflow_id]
    if query:
        executions = [
            item for item in executions
            if query in str(item.get("workflow_name", "")).casefold()
            or query in str(item.get("execution_id", "")).casefold()
        ]
    ordered_executions = sorted(
        enumerate(executions),
        key=lambda item: (item[1].get("started_at", ""), item[0]),
        reverse=True,
    )
    return jsonify([item for _index, item in ordered_executions])


@workflows_blueprint.get("/executions/<execution_id>")
def get_execution(execution_id: str):
    try:
        execution = MetadataService(current_app.extensions["etl_storage"]).get_execution(execution_id)
    except RuntimeError as exc:
        current_app.logger.exception("Execution history could not be read: %s", exc)
        return jsonify({"error": "Execution history could not be read."}), 500
    if execution is None:
        return jsonify({"error": "Execution not found."}), 404
    return jsonify(execution)


def _delete_execution_records(execution_ids: list[str]):
    storage = current_app.extensions["etl_storage"]
    metadata = MetadataService(storage)
    if any(not storage.file_id_is_valid(execution_id) for execution_id in execution_ids):
        return jsonify({"error": "One or more execution identifiers are invalid."}), 400
    current = {item.get("execution_id"): item for item in metadata.list_executions()}
    deleted = []
    failed = []
    for execution_id in dict.fromkeys(execution_ids):
        execution = current.get(execution_id)
        if execution is None:
            failed.append({"execution_id": execution_id, "error": "Execution not found."})
            continue
        if execution.get("status") == "running":
            failed.append({"execution_id": execution_id, "error": "A running execution cannot be deleted."})
            continue
        try:
            metadata.delete_executions({execution_id})
        except (OSError, RuntimeError, ValueError) as exc:
            current_app.logger.exception("Execution history deletion failed for %s", execution_id)
            failed.append({"execution_id": execution_id, "error": str(exc) or "Execution history could not be deleted."})
            continue
        artifacts = storage.delete_execution_artifacts(execution_id)
        deleted.append({
            "execution_id": execution_id,
            "artifacts_deleted": artifacts["deleted"],
            "artifact_failures": artifacts["failed"],
        })
        current_app.logger.info("Deleted execution history %s", execution_id)
    return jsonify({"deleted": deleted, "failed": failed, "deleted_count": len(deleted), "partial": bool(failed) or any(item["artifact_failures"] for item in deleted)}), 200


@workflows_blueprint.delete("/executions/<execution_id>")
def delete_execution(execution_id: str):
    if not current_app.extensions["etl_storage"].file_id_is_valid(execution_id):
        return jsonify({"error": "Execution identifier is invalid."}), 400
    response, status_code = _delete_execution_records([execution_id])
    if status_code != 200:
        return response, status_code
    result = response.get_json()
    if not result["deleted"]:
        failure = result["failed"][0]
        return jsonify({"error": failure["error"]}), (409 if "running execution" in failure["error"] else 404)
    if result["deleted"][0]["artifact_failures"]:
        return jsonify({
            "deleted": True,
            "partial": True,
            **result["deleted"][0],
            "warning": "History was deleted, but some execution artifacts could not be removed.",
        })
    return jsonify({"deleted": True, **result["deleted"][0]})


@workflows_blueprint.post("/executions/delete-selected")
def delete_selected_executions():
    payload = request.get_json(silent=True) or {}
    execution_ids = payload.get("execution_ids")
    if not isinstance(execution_ids, list) or not execution_ids or len(execution_ids) > 500:
        return jsonify({"error": "Select between 1 and 500 executions to delete."}), 400
    if any(not isinstance(execution_id, str) or not execution_id for execution_id in execution_ids):
        return jsonify({"error": "Every execution identifier must be a non-empty string."}), 400
    return _delete_execution_records(execution_ids)


@workflows_blueprint.delete("/executions/clear")
def clear_executions():
    metadata = MetadataService(current_app.extensions["etl_storage"])
    return _delete_execution_records([item.get("execution_id", "") for item in metadata.list_executions()])


def _execution_node_preview(storage, execution: dict, node_id: str, page_size: int = 100):
    status = execution.get("node_statuses", {}).get(node_id)
    if status is None:
        return jsonify({"error": "Node not found in this execution."}), 404
    node = {
        "id": node_id,
        "name": status.get("node_name", node_id),
        "type": status.get("node_type"),
    }
    common = {
        "node": node,
        "execution_id": execution["execution_id"],
        "execution_status": execution.get("status"),
        "execution_timestamp": execution.get("completed_at") or execution.get("started_at"),
        "status": status.get("status"),
        "error": status.get("error"),
        "total_rows": status.get("rows", 0),
        "total_columns": status.get("columns", 0),
        "column_metadata": status.get("column_metadata", []),
        "executed_at": status.get("executed_at"),
        "rows": [],
        "columns": [],
        "page": 1,
        "page_size": page_size,
        "total_pages": 1,
        "has_more": False,
    }
    if status.get("status") in {"failed", "skipped"}:
        return jsonify(common)
    if status.get("status") in {"pending", "running"}:
        return jsonify(common), 409

    preview = execution.get("previews", {}).get(node_id)
    if preview is None or not status.get("output_available"):
        return jsonify({**common, "no_output": True})

    try:
        page = request.args.get("page", default=1, type=int)
        requested_page_size = request.args.get("page_size", default=page_size, type=int)
        query = request.args.get("q", default="", type=str)
        if len(query) > 200:
            return jsonify({"error": "Search text must be 200 characters or fewer."}), 400
        dataset = {
            "file_id": execution["execution_id"],
            "execution_id": execution["execution_id"],
            "node_id": node_id,
            "filename": preview.get("dataset_name", node["name"]),
            "file_type": "json",
            "status": "preview",
        }
        data = DatasetService(storage).preview(dataset, page, requested_page_size, query)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError:
        return jsonify({"error": "The stored node output could not be found."}), 404
    except (OSError, RuntimeError, UnicodeDecodeError, ValueError) as exc:
        current_app.logger.exception("Node output could not be read: %s", exc)
        return jsonify({"error": "The node output could not be read."}), 500
    return jsonify({
        **common,
        **data,
        "status": "success",
        "node": node,
        "execution_id": execution["execution_id"],
        "execution_status": execution.get("status"),
        "execution_timestamp": execution.get("completed_at") or execution.get("started_at"),
        "executed_at": preview.get("executed_at"),
        "total_rows": data["total_rows"],
        "total_columns": preview.get("column_count", len(data["columns"])),
        "column_metadata": preview.get("columns", []),
        "preview": preview,
    })


@workflows_blueprint.get("/workflows/<workflow_id>/nodes/<node_id>/preview")
def get_latest_workflow_node_preview(workflow_id: str, node_id: str):
    storage = current_app.extensions["etl_storage"]
    metadata = MetadataService(storage)
    try:
        workflow = metadata.get_workflow(workflow_id)
        executions = metadata.list_executions()
    except (RuntimeError, ValueError) as exc:
        current_app.logger.exception("Workflow node preview metadata could not be read: %s", exc)
        return jsonify({"error": "Workflow node preview could not be read."}), 500
    if workflow is None:
        return jsonify({"error": "Workflow not found."}), 404

    execution_id = request.args.get("execution_id")
    if execution_id:
        execution = next((
            item for item in executions
            if item.get("execution_id") == execution_id and item.get("workflow_id") == workflow_id
        ), None)
    else:
        ordered_executions = sorted(
            enumerate(executions),
            key=lambda item: (item[1].get("started_at", ""), item[0]),
            reverse=True,
        )
        execution = next((
            item for _index, item in ordered_executions
            if item.get("workflow_id") == workflow_id
        ), None)
    if execution is None:
        return jsonify({"error": "Run the workflow to view this node's output."}), 404
    return _execution_node_preview(storage, execution, node_id, page_size=50)


@workflows_blueprint.get("/executions/<execution_id>/previews/<node_id>")
def get_execution_preview(execution_id: str, node_id: str):
    storage = current_app.extensions["etl_storage"]
    metadata = MetadataService(storage)
    try:
        execution = metadata.get_execution(execution_id)
    except RuntimeError as exc:
        current_app.logger.exception("Execution preview metadata could not be read: %s", exc)
        return jsonify({"error": "Execution preview could not be read."}), 500
    if execution is None:
        return jsonify({"error": "Execution not found."}), 404
    return _execution_node_preview(storage, execution, node_id, page_size=100)


@workflows_blueprint.delete("/workflows/<workflow_id>")
def delete_workflow(workflow_id: str):
    try:
        deleted = MetadataService(current_app.extensions["etl_storage"]).delete_workflow(workflow_id)
    except ValueError:
        deleted = False
    if not deleted:
        return jsonify({"error": "Workflow not found."}), 404
    return jsonify({"deleted": True, "workflow_id": workflow_id})