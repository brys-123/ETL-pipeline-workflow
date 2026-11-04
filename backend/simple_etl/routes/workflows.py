import math
from flask import Blueprint, current_app, jsonify, request

from ..services.metadata_service import MetadataService
from ..utils.helpers import utc_now

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


@workflows_blueprint.delete("/workflows/<workflow_id>")
def delete_workflow(workflow_id: str):
    try:
        deleted = MetadataService(current_app.extensions["etl_storage"]).delete_workflow(workflow_id)
    except ValueError:
        deleted = False
    if not deleted:
        return jsonify({"error": "Workflow not found."}), 404
    return jsonify({"deleted": True, "workflow_id": workflow_id})