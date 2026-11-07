from collections import defaultdict, deque
from typing import Any


INPUT_TYPES = {"csv_input": "csv", "excel_input": "xlsx", "json_input": "json"}
TRANSFORM_TYPES = {
    "clean_data",
    "remove_duplicates",
    "filter_rows",
    "select_columns",
    "rename_columns",
    "aggregate_data",
    "merge_data",
    "preview_data",
    "view_data",
}
OUTPUT_TYPES = {"csv_output": "csv", "excel_output": "xlsx", "json_output": "json"}
PREVIEW_TYPES = {"preview_data", "view_data"}
NODE_TYPES = set(INPUT_TYPES) | TRANSFORM_TYPES | set(OUTPUT_TYPES)
CLEANING_OPERATIONS = {
    "remove_missing_rows",
    "remove_missing_columns",
    "fill_missing",
    "remove_duplicates",
    "trim_text",
    "uppercase",
    "lowercase",
    "titlecase",
    "replace_text",
    "remove_unwanted_characters",
    "convert_type",
    "remove_columns",
    "select_columns",
    "rename_column",
    "reorder_columns",
}


def plan_workflow(workflow: dict[str, Any], metadata: Any) -> tuple[list[dict[str, Any]], list[str]]:
    nodes = workflow.get("nodes", [])
    edges = workflow.get("edges", [])
    errors: list[str] = []
    by_id = {node.get("id"): node for node in nodes}
    if len(by_id) != len(nodes):
        return [], ["Workflow node identifiers must be unique."]
    if not any(node.get("type") in INPUT_TYPES for node in nodes):
        errors.append("Add at least one configured input node.")
    sink_types = set(OUTPUT_TYPES) | PREVIEW_TYPES
    if not any(node.get("type") in sink_types for node in nodes):
        errors.append("Add at least one file output or Preview Data node.")

    incoming: dict[str, list[str]] = defaultdict(list)
    outgoing: dict[str, list[str]] = defaultdict(list)
    edge_pairs: set[tuple[str, str]] = set()
    for edge in edges:
        source, target = edge.get("source"), edge.get("target")
        if source not in by_id or target not in by_id or source == target:
            errors.append("Every connection must join two different workflow nodes.")
            continue
        if (source, target) in edge_pairs:
            errors.append("Duplicate workflow connections are not allowed.")
            continue
        edge_pairs.add((source, target))
        source_type, target_type = by_id[source].get("type"), by_id[target].get("type")
        if source_type not in NODE_TYPES or target_type not in NODE_TYPES:
            errors.append("A connection contains an unsupported node type.")
            continue
        if source_type in OUTPUT_TYPES:
            errors.append("Output nodes cannot have outgoing connections.")
        if target_type in INPUT_TYPES:
            errors.append("Input nodes cannot have incoming connections.")
        if target_type != "merge_data" and incoming[target]:
            errors.append(f"{by_id[target].get('name', target)} accepts only one incoming connection.")
        incoming[target].append(source)
        outgoing[source].append(target)

    for node in nodes:
        node_id, node_type = node.get("id"), node.get("type")
        config = node.get("config", {})
        parents = incoming[node_id]
        if node_type not in NODE_TYPES:
            errors.append(f"Node {node.get('name', node_id)} has an unsupported type.")
            continue
        if node_type in INPUT_TYPES:
            file_id = config.get("file_id")
            record = metadata.get_file(file_id) if isinstance(file_id, str) else None
            if not record or record.get("file_type") != INPUT_TYPES[node_type] or record.get("status") != "uploaded":
                errors.append(f"Select an existing {INPUT_TYPES[node_type].upper()} dataset for {node.get('name', node_id)}.")
        elif node_type == "merge_data":
            if len(parents) != 2:
                errors.append(f"Merge node {node.get('name', node_id)} needs exactly two connected input datasets.")
            if len(parents) > 2:
                errors.append(f"Merge node {node.get('name', node_id)} accepts at most two input connections.")
            if not isinstance(config.get("left_on"), str) or not config.get("left_on") or not isinstance(config.get("right_on"), str) or not config.get("right_on") or config.get("how", "inner") not in {"inner", "left", "right", "outer"}:
                errors.append(f"Configure matching left and right columns and a supported join type for {node.get('name', node_id)}.")
        elif node_type not in OUTPUT_TYPES and len(parents) != 1:
            errors.append(f"Node {node.get('name', node_id)} needs exactly one input connection.")
        elif node_type in OUTPUT_TYPES and len(parents) != 1:
            errors.append(f"Output node {node.get('name', node_id)} needs exactly one input connection.")

        if node_type == "clean_data" and config.get("operation", "trim_text") not in CLEANING_OPERATIONS:
            errors.append(f"Choose a supported cleaning operation for {node.get('name', node_id)}.")
        elif node_type == "remove_duplicates" and config.get("columns") is not None and (
            not isinstance(config.get("columns"), list)
            or any(not isinstance(column, str) or not column for column in config.get("columns", []))
        ):
            errors.append(f"Choose valid duplicate comparison columns for {node.get('name', node_id)}.")
        elif node_type == "filter_rows":
            if not config.get("column") or config.get("operator") not in {
                "equals", "not_equals", "greater_than", "less_than", "contains", "not_contains", "is_null", "not_null",
            }:
                errors.append(f"Configure a column and supported condition for {node.get('name', node_id)}.")
        elif node_type == "select_columns" and (
            not isinstance(config.get("columns"), list)
            or not config.get("columns")
            or any(not isinstance(column, str) or not column for column in config.get("columns", []))
        ):
            errors.append(f"Choose columns to keep for {node.get('name', node_id)}.")
        elif node_type == "rename_columns" and (not config.get("from") or not config.get("to")):
            errors.append(f"Configure the old and new names for {node.get('name', node_id)}.")
        elif node_type == "aggregate_data" and (
            not config.get("group_by")
            or config.get("operation") not in {"sum", "mean", "average", "count", "min", "max", "median"}
        ):
            errors.append(f"Configure a grouping column and aggregation for {node.get('name', node_id)}.")
        elif node_type in {"csv_output", "excel_output", "json_output"} and not config.get("filename"):
            errors.append(f"Enter an output filename for {node.get('name', node_id)}.")

    indegree = {node.get("id"): len(incoming[node.get("id")]) for node in nodes}
    queue = deque(node_id for node_id, degree in indegree.items() if degree == 0)
    ordered_ids: list[str] = []
    while queue:
        node_id = queue.popleft()
        ordered_ids.append(node_id)
        for target in outgoing[node_id]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if len(ordered_ids) != len(nodes):
        errors.append("Workflow connections contain a cycle.")

    input_ids = {node.get("id") for node in nodes if node.get("type") in INPUT_TYPES}
    output_ids = {node.get("id") for node in nodes if node.get("type") in sink_types}
    reachable: set[str] = set(input_ids)
    for node_id in ordered_ids:
        if node_id in reachable:
            reachable.update(outgoing[node_id])
    for node in nodes:
        if node.get("id") not in reachable:
            errors.append(f"Node {node.get('name', node.get('id'))} is not connected to a dataset input.")
    can_reach_output = set(output_ids)
    for node_id in reversed(ordered_ids):
        if any(child in can_reach_output for child in outgoing[node_id]):
            can_reach_output.add(node_id)
    for node in nodes:
        if node.get("id") not in can_reach_output:
            errors.append(f"Node {node.get('name', node.get('id'))} does not lead to an output.")
    return [by_id[node_id] for node_id in ordered_ids if node_id in by_id], list(dict.fromkeys(errors))
