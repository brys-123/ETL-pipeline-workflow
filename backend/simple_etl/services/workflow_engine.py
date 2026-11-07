import time
from pathlib import Path
from typing import Any
from uuid import uuid4

import pandas as pd
from werkzeug.utils import secure_filename

from .cleaning_service import CleaningService
from .dataset_service import DatasetService
from .metadata_service import MetadataService
from .storage_service import FileSystemStorage
from ..utils.helpers import utc_now

INPUT_TYPES = {"csv_input": "csv", "excel_input": "xlsx", "json_input": "json"}
OUTPUT_TYPES = {"csv_output": "csv", "excel_output": "xlsx", "json_output": "json"}
TRANSFORM_TYPES = {"clean_data", "remove_duplicates", "filter_rows", "select_columns", "rename_columns", "aggregate_data", "merge_data", "data_view"}


class WorkflowValidationError(ValueError):
    pass


class WorkflowExecutionError(RuntimeError):
    def __init__(self, message: str, node_id: str | None = None, execution_id: str | None = None):
        super().__init__(message)
        self.node_id = node_id
        self.execution_id = execution_id


def _column_list(value: Any, label: str) -> list[str]:
    if isinstance(value, str):
        value = [item.strip() for item in value.split(",") if item.strip()]
    if not isinstance(value, list) or not value or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(f"Choose one or more {label}.")
    return value


class WorkflowEngine:
    def __init__(self, storage: FileSystemStorage, metadata: MetadataService):
        self.storage = storage
        self.metadata = metadata

    def execution_order(self, workflow: dict[str, Any]) -> list[dict[str, Any]]:
        nodes = workflow.get("nodes", [])
        edges = workflow.get("edges", [])
        if not isinstance(nodes, list) or not isinstance(edges, list) or not nodes:
            raise WorkflowValidationError("Add nodes to the workflow before running it.")
        by_id = {node.get("id"): node for node in nodes if isinstance(node, dict)}
        if len(by_id) != len(nodes) or None in by_id:
            raise WorkflowValidationError("Workflow node identifiers must be unique.")
        inputs = [node for node in nodes if node.get("type") in INPUT_TYPES]
        outputs = [node for node in nodes if node.get("type") in OUTPUT_TYPES]
        if not inputs:
            raise WorkflowValidationError("Add at least one input node.")
        if not outputs:
            raise WorkflowValidationError("Add at least one output node.")

        incoming = {node_id: [] for node_id in by_id}
        outgoing = {node_id: [] for node_id in by_id}
        pairs = set()
        for edge in edges:
            if not isinstance(edge, dict):
                raise WorkflowValidationError("Every connection must be an object.")
            source, target = edge.get("source"), edge.get("target")
            if source not in by_id or target not in by_id or source == target or (source, target) in pairs:
                raise WorkflowValidationError("Connections must uniquely join different existing nodes.")
            if by_id[source].get("type") in OUTPUT_TYPES or by_id[target].get("type") in INPUT_TYPES:
                raise WorkflowValidationError("Connections cannot leave output nodes or enter input nodes.")
            pairs.add((source, target))
            outgoing[source].append(target)
            incoming[target].append(source)

        for node_id, node in by_id.items():
            node_type = node.get("type")
            if not isinstance(node_type, str) or (node_type not in INPUT_TYPES and node_type not in OUTPUT_TYPES and node_type not in TRANSFORM_TYPES):
                raise WorkflowValidationError(f"Node type is not supported: {node_type}.")
            config = node.get("config", {})
            if not isinstance(config, dict):
                raise WorkflowValidationError(f"{node.get('name', node_type)} settings must be an object.")
            if node_type in INPUT_TYPES and incoming[node_id]:
                raise WorkflowValidationError("Input nodes cannot have incoming connections.")
            if node_type not in INPUT_TYPES and len(incoming[node_id]) != (2 if node_type == "merge_data" else 1):
                raise WorkflowValidationError(f"{node.get('name', node_type)} must have {2 if node_type == 'merge_data' else 1} incoming connection(s).")
            if node_type in OUTPUT_TYPES and outgoing[node_id]:
                raise WorkflowValidationError("Output nodes cannot have outgoing connections.")
            if node_type not in OUTPUT_TYPES and not outgoing[node_id]:
                raise WorkflowValidationError(f"{node.get('name', node_type)} must connect to another node.")
            if node_type in INPUT_TYPES:
                file_id = config.get("file_id")
                record = self.metadata.get_file(file_id) if isinstance(file_id, str) else None
                if record is None:
                    raise WorkflowValidationError(f"Select an existing dataset for {node.get('name', 'input node')}.")
                if record.get("file_type") != INPUT_TYPES[node_type]:
                    raise WorkflowValidationError(f"{node.get('name', 'Input node')} requires a {INPUT_TYPES[node_type].upper()} dataset.")
            if node_type == "clean_data":
                operation = config.get("operation")
                operations = config.get("operations")
                if operations is not None:
                    if not isinstance(operations, list) or not operations:
                        raise WorkflowValidationError("Clean Data needs at least one configured operation.")
                    if any(not isinstance(item, dict) or not isinstance(item.get("operation"), str) or item["operation"] not in CleaningService.OPERATIONS or not isinstance(item.get("config", {}), dict) for item in operations):
                        raise WorkflowValidationError("Clean Data contains an unsupported or invalid operation.")
                elif not isinstance(operation, str) or operation not in CleaningService.OPERATIONS:
                    raise WorkflowValidationError("Choose a supported operation for the Clean Data node.")
            elif node_type == "filter_rows":
                operator = config.get("operator")
                if not isinstance(config.get("column"), str) or not isinstance(operator, str) or operator not in {"equals", "not_equals", "contains", "does_not_contain", "greater_than", "less_than", "is_null", "is_not_null"}:
                    raise WorkflowValidationError("Configure a filter column and supported condition.")
                if operator not in {"is_null", "is_not_null"} and "value" not in config:
                    raise WorkflowValidationError("Enter a value for the row filter.")
            elif node_type == "select_columns":
                try:
                    _column_list(config.get("columns"), "columns to keep")
                except ValueError as exc:
                    raise WorkflowValidationError(str(exc)) from exc
            elif node_type == "rename_columns":
                if not isinstance(config.get("from"), str) or not isinstance(config.get("to"), str) or not config["to"].strip():
                    raise WorkflowValidationError("Configure the current and new column names.")
            elif node_type == "aggregate_data":
                try:
                    _column_list(config.get("group_by"), "grouping columns")
                except ValueError as exc:
                    raise WorkflowValidationError(str(exc)) from exc
                if not isinstance(config.get("operation"), str) or config["operation"] not in {"sum", "mean", "count", "min", "max", "median"}:
                    raise WorkflowValidationError("Choose a supported aggregation operation.")
                if config.get("operation") != "count" and not isinstance(config.get("column"), str):
                    raise WorkflowValidationError("Choose a value column to aggregate.")
            elif node_type == "merge_data":
                how = config.get("how", "inner")
                if not isinstance(config.get("left_on"), str) or not isinstance(config.get("right_on"), str) or not isinstance(how, str) or how not in {"inner", "left", "right", "outer"}:
                    raise WorkflowValidationError("Configure both merge columns and a supported join type.")

        indegrees = {node_id: len(incoming[node_id]) for node_id in by_id}
        ready = [node_id for node_id, degree in indegrees.items() if degree == 0]
        ordered_ids = []
        while ready:
            current = ready.pop()
            ordered_ids.append(current)
            for target in outgoing[current]:
                indegrees[target] -= 1
                if indegrees[target] == 0:
                    ready.append(target)
        if len(ordered_ids) != len(by_id):
            raise WorkflowValidationError("Workflow contains a cycle. Remove the circular connection before running it.")
        if any(node_id not in ordered_ids for node_id in by_id):
            raise WorkflowValidationError("Workflow graph is disconnected.")
        return [by_id[node_id] for node_id in ordered_ids]

    def _read_input(self, node: dict[str, Any]) -> pd.DataFrame:
        file_id = node.get("config", {}).get("file_id")
        if not isinstance(file_id, str):
            raise WorkflowValidationError(f"Select a dataset for {node.get('name', 'input node')}.")
        record = self.metadata.get_file(file_id)
        if record is None:
            raise WorkflowValidationError(f"The selected dataset for {node.get('name', 'input node')} no longer exists.")
        expected_type = INPUT_TYPES[node["type"]]
        if record.get("file_type") != expected_type:
            raise WorkflowValidationError(f"{node.get('name', 'Input node')} requires a {expected_type.upper()} dataset.")
        path_getter = self.storage.processed_path if record.get("status") == "processed" else self.storage.upload_path
        try:
            path = path_getter(file_id, f".{expected_type}")
            return DatasetService(path, expected_type).read()
        except (OSError, ValueError) as exc:
            raise WorkflowExecutionError(f"Could not read dataset {record.get('filename', file_id)}.") from exc

    @staticmethod
    def _filter(frame: pd.DataFrame, config: dict[str, Any]) -> pd.DataFrame:
        column, operator = config.get("column"), config.get("operator")
        if not isinstance(column, str) or column not in frame.columns:
            raise ValueError("Choose an existing column for the row filter.")
        series = frame[column]
        value = config.get("value", "")
        if operator == "is_null":
            mask = series.isna()
        elif operator == "is_not_null":
            mask = series.notna()
        elif operator in {"contains", "does_not_contain"}:
            mask = series.astype("string").str.contains(str(value), case=False, regex=False, na=False)
            if operator == "does_not_contain":
                mask = ~mask
        elif operator in {"equals", "not_equals", "greater_than", "less_than"}:
            comparable = series
            if operator in {"greater_than", "less_than"} and not pd.api.types.is_numeric_dtype(series):
                comparable = pd.to_numeric(series, errors="coerce")
                if (series.notna() & comparable.isna()).any():
                    raise ValueError("Greater-than and less-than filters require a numeric column.")
            if pd.api.types.is_numeric_dtype(comparable):
                try:
                    value = float(value)
                except (TypeError, ValueError) as exc:
                    raise ValueError("Enter a numeric filter value for this column.") from exc
            if operator == "equals":
                mask = comparable == value
            elif operator == "not_equals":
                mask = comparable != value
            elif operator == "greater_than":
                mask = comparable > value
            else:
                mask = comparable < value
        else:
            raise ValueError("Choose a supported row-filter condition.")
        return frame.loc[mask.fillna(False)].copy()

    @staticmethod
    def _aggregate(frame: pd.DataFrame, config: dict[str, Any]) -> pd.DataFrame:
        groups = _column_list(config.get("group_by"), "grouping columns")
        if any(column not in frame.columns for column in groups):
            raise ValueError("Every grouping column must exist in the incoming dataset.")
        operation = config.get("operation")
        column = config.get("column")
        if operation == "count" and not column:
            return frame.groupby(groups, dropna=False).size().reset_index(name="count")
        if not isinstance(column, str) or column not in frame.columns:
            raise ValueError("Choose an existing value column to aggregate.")
        functions = {"sum": "sum", "mean": "mean", "count": "count", "min": "min", "max": "max", "median": "median"}
        if operation not in functions:
            raise ValueError("Choose sum, mean, count, min, max, or median.")
        if operation in {"sum", "mean", "median", "min", "max"} and not pd.api.types.is_numeric_dtype(frame[column]):
            raise ValueError(f"{operation.title()} aggregation requires a numeric value column.")
        return frame.groupby(groups, dropna=False)[column].agg(functions[operation]).reset_index()

    @staticmethod
    def _merge(frames: list[pd.DataFrame], config: dict[str, Any]) -> pd.DataFrame:
        if len(frames) != 2:
            raise ValueError("Connect exactly two datasets to the Merge Data node.")
        how = config.get("how", "inner")
        if not isinstance(how, str) or how not in {"inner", "left", "right", "outer"}:
            raise ValueError("Choose inner, left, right, or outer join.")
        left_on, right_on = config.get("left_on", config.get("on")), config.get("right_on", config.get("on"))
        if not isinstance(left_on, str) or not isinstance(right_on, str):
            raise ValueError("Choose a matching column from each incoming dataset.")
        if left_on not in frames[0].columns or right_on not in frames[1].columns:
            raise ValueError("The selected merge columns must exist in their respective inputs.")
        return pd.merge(frames[0], frames[1], how=how, left_on=left_on, right_on=right_on, suffixes=("_left", "_right"))

    def _write_output(self, node: dict[str, Any], frame: pd.DataFrame, workflow: dict[str, Any]) -> dict[str, Any]:
        file_type = OUTPUT_TYPES[node["type"]]
        extension = f".{file_type}"
        file_id = uuid4().hex
        path = self.storage.processed_path(file_id, extension)
        configured_name = node.get("config", {}).get("filename") or workflow["name"]
        safe_stem = secure_filename(Path(str(configured_name)).stem) or "processed-dataset"
        filename = f"{safe_stem}{extension}"
        content = DatasetService.export(frame, file_type)
        record = {
            "file_id": file_id,
            "filename": filename,
            "file_type": file_type,
            "file_size": len(content),
            "uploaded_at": utc_now(),
            "status": "processed",
            "stored_name": f"{file_id}{extension}",
            "workflow_id": workflow["workflow_id"],
            "row_count": int(len(frame)),
            "column_count": int(len(frame.columns)),
        }
        try:
            path.write_bytes(content)
            self.metadata.save_file(record)
        except (OSError, RuntimeError) as exc:
            path.unlink(missing_ok=True)
            raise WorkflowExecutionError("Could not save an output dataset.") from exc
        return record

    def execute(self, workflow: dict[str, Any]) -> dict[str, Any]:
        order = self.execution_order(workflow)
        started = utc_now()
        start_time = time.perf_counter()
        execution_id = uuid4().hex
        record = {
            "execution_id": execution_id,
            "workflow_id": workflow["workflow_id"],
            "workflow_name": workflow["name"],
            "started_at": started,
            "completed_at": None,
            "status": "running",
            "input_file_ids": [],
            "output_file_ids": [],
            "operations": [],
            "summary": {},
            "error_message": None,
            "failing_node": None,
        }
        self.metadata.save_execution(record)
        values: dict[str, pd.DataFrame] = {}
        outputs = []
        try:
            for node in order:
                node_id, node_type = node["id"], node["type"]
                parents = [edge["source"] for edge in workflow["edges"] if edge["target"] == node_id]
                config = node.get("config", {})
                if node_type in INPUT_TYPES:
                    frame = self._read_input(node)
                    record["input_file_ids"].append(config["file_id"])
                else:
                    incoming = [values[parent] for parent in parents]
                    frame = incoming[0].copy()
                    if node_type == "data_view":
                        pass
                    elif node_type == "remove_duplicates":
                        columns = config.get("columns")
                        if isinstance(columns, str):
                            columns = _column_list(columns, "duplicate comparison columns")
                        if columns is not None and not isinstance(columns, list):
                            raise ValueError("Duplicate comparison columns must be a list.")
                        if columns and any(column not in frame.columns for column in columns):
                            raise ValueError("Duplicate comparison columns must exist in the incoming dataset.")
                        frame = frame.drop_duplicates(subset=columns or None, keep="first")
                    elif node_type == "filter_rows":
                        frame = self._filter(frame, config)
                    elif node_type == "select_columns":
                        columns = _column_list(config.get("columns"), "columns to keep")
                        if any(column not in frame.columns for column in columns):
                            raise ValueError("Every selected column must exist in the incoming dataset.")
                        frame = frame.loc[:, columns].copy()
                    elif node_type == "rename_columns":
                        old, new = config.get("from"), config.get("to")
                        if old not in frame.columns or not isinstance(new, str) or not new.strip():
                            raise ValueError("Choose an existing column and enter its new name.")
                        if new.strip() != old and new.strip() in frame.columns:
                            raise ValueError("The new column name already exists.")
                        frame = frame.rename(columns={old: new.strip()})
                    elif node_type == "aggregate_data":
                        frame = self._aggregate(frame, config)
                    elif node_type == "merge_data":
                        frame = self._merge(incoming, config)
                    elif node_type == "clean_data":
                        operations = config.get("operations")
                        if operations is None and isinstance(config.get("operation"), str):
                            options = config.get("options")
                            if not isinstance(options, dict):
                                options = {key: value for key, value in config.items() if key not in {"operation", "text_action"}}
                            if isinstance(options.get("columns"), str):
                                options["columns"] = _column_list(options["columns"], "columns")
                            if config["operation"] == "clean_text":
                                options.setdefault("action", config.get("text_action", "trim"))
                            operations = [{"operation": config["operation"], "config": options}]
                        if not isinstance(operations, list) or not operations:
                            raise ValueError("Configure at least one cleaning operation.")
                        for item in operations:
                            if not isinstance(item, dict) or not isinstance(item.get("operation"), str) or not isinstance(item.get("config", {}), dict):
                                raise ValueError("Clean Data operations need an operation name and an options object.")
                            frame, _details = CleaningService.apply(frame, item["operation"], item.get("config", {}))
                    elif node_type in OUTPUT_TYPES:
                        output = self._write_output(node, frame, workflow)
                        outputs.append(output)
                        record["output_file_ids"].append(output["file_id"])
                    else:
                        raise ValueError(f"Unsupported node type: {node_type}.")
                    record["operations"].append({"node_id": node_id, "node_name": node.get("name", node_type), "type": node_type})
                values[node_id] = frame
                record["failing_node"] = None

            final_frame = values[order[-1]["id"]]
            record["status"] = "completed"
            record["summary"] = {
                "input_rows": sum(len(values[node["id"]]) for node in order if node["type"] in INPUT_TYPES),
                "final_rows": int(len(final_frame)),
                "final_columns": int(len(final_frame.columns)),
                "duration_ms": round((time.perf_counter() - start_time) * 1000),
            }
        except (ValueError, KeyError, OSError, TypeError, WorkflowExecutionError) as exc:
            record["status"] = "failed"
            record["error_message"] = str(exc)
            current_node = node if "node" in locals() else None
            record["failing_node"] = current_node.get("id") if current_node else None
            for output in outputs:
                path = self.storage.processed_path(output["file_id"], f".{output['file_type']}")
                path.unlink(missing_ok=True)
                self.metadata.delete_file(output["file_id"])
            record["output_file_ids"] = []
            raise WorkflowExecutionError(str(exc), record["failing_node"], execution_id) from exc
        finally:
            record["completed_at"] = utc_now()
            record["summary"]["duration_ms"] = round((time.perf_counter() - start_time) * 1000)
            self.metadata.save_execution(record)
        record.pop("error_message", None)
        record.pop("failing_node", None)
        return {**record, "outputs": outputs}
