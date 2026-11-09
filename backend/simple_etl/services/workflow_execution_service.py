import re
import logging
import threading
import time
from pathlib import Path
from threading import Thread
from typing import Any
from uuid import uuid4

import pandas as pd
from werkzeug.utils import secure_filename

from ..utils.helpers import utc_now
from .cleaning_service import CleaningError, apply_cleaning
from .dataset_service import DatasetService
from .metadata_service import MetadataService
from .storage_service import FileSystemStorage
from .connection_manager import ConnectionManager
from .external_sources import ExternalSourceError, ExternalSourceService, MAX_EXTRACT_ROWS
from .workflow_graph import EXTERNAL_INPUT_TYPES, FILE_INPUT_TYPES, INPUT_TYPES, OUTPUT_TYPES, PREVIEW_TYPES, plan_workflow

_execution_lock = threading.Lock()
_logger = logging.getLogger(__name__)

NUMERIC_SUMMARY_STATISTICS = (
    "count", "missing_values", "mean", "median", "mode", "minimum", "maximum", "range",
    "standard_deviation", "variance", "q1", "q3", "iqr", "sum", "skewness", "kurtosis",
)
CATEGORICAL_SUMMARY_STATISTICS = (
    "count", "missing_values", "unique_values", "distinct_categories", "mode", "frequency", "percentage",
)
SUMMARY_COLUMNS = (
    "summary_type", "column", "statistic", "value", "category", "frequency", "percentage", "top_rank",
)


def acquire_storage_switch() -> bool:
    return _execution_lock.acquire(blocking=False)


def release_storage_switch() -> None:
    _execution_lock.release()


class WorkflowExecutionError(ValueError):
    def __init__(self, message: str, node_id: str | None = None):
        super().__init__(message)
        self.node_id = node_id


def _column(frame: pd.DataFrame, name: Any) -> str:
    if not isinstance(name, str) or name not in frame.columns:
        raise WorkflowExecutionError("A configured column does not exist in its input dataset.")
    return name


def _filter(frame: pd.DataFrame, config: dict[str, Any]) -> pd.DataFrame:
    name = _column(frame, config.get("column"))
    operator = config.get("operator")
    value = config.get("value", "")
    series = frame[name]
    try:
        if operator == "equals":
            comparison = pd.to_numeric(value, errors="raise") if pd.api.types.is_numeric_dtype(series) else value
            mask = series == comparison
        elif operator == "not_equals":
            comparison = pd.to_numeric(value, errors="raise") if pd.api.types.is_numeric_dtype(series) else value
            mask = series != comparison
        elif operator == "greater_than":
            mask = pd.to_numeric(series, errors="raise") > float(value)
        elif operator == "less_than":
            mask = pd.to_numeric(series, errors="raise") < float(value)
        elif operator == "contains":
            mask = series.astype("string").str.contains(str(value), case=False, na=False, regex=False)
        elif operator == "not_contains":
            mask = ~series.astype("string").str.contains(str(value), case=False, na=False, regex=False)
        elif operator == "is_null":
            mask = series.isna()
        elif operator == "not_null":
            mask = series.notna()
        else:
            raise WorkflowExecutionError("Choose a supported row filter condition.")
    except WorkflowExecutionError:
        raise
    except (TypeError, ValueError, OverflowError) as exc:
        raise WorkflowExecutionError(f"Could not apply the filter to column {name}.") from exc
    return frame.loc[mask].copy()


def _summary_number(value: Any, precision: int) -> Any:
    if isinstance(value, list):
        return [_summary_number(item, precision) for item in value]
    if pd.isna(value):
        return None
    if isinstance(value, (int, float)):
        return round(value, precision) if isinstance(value, float) else int(value)
    if hasattr(value, "item"):
        return _summary_number(value.item(), precision)
    return value


def statistical_summary(frame: pd.DataFrame, config: dict[str, Any]) -> pd.DataFrame:
    selection = config.get("column_selection", "automatic")
    if selection not in {"automatic", "manual"}:
        raise WorkflowExecutionError("Choose automatic or manual column selection.")

    try:
        precision = int(config.get("precision", 3))
        top_categories = int(config.get("top_categories", 10))
    except (TypeError, ValueError, OverflowError) as exc:
        raise WorkflowExecutionError("Decimal precision and top category count must be whole numbers.") from exc
    if not 0 <= precision <= 10:
        raise WorkflowExecutionError("Choose a decimal precision from 0 to 10.")
    if not 1 <= top_categories <= 100:
        raise WorkflowExecutionError("Choose between 1 and 100 top categories.")

    numeric_types = [name for name in frame.columns if pd.api.types.is_numeric_dtype(frame[name].dtype)]
    categorical_types = [
        name for name in frame.columns
        if pd.api.types.is_object_dtype(frame[name].dtype)
        or pd.api.types.is_string_dtype(frame[name].dtype)
        or isinstance(frame[name].dtype, pd.CategoricalDtype)
        or pd.api.types.is_bool_dtype(frame[name].dtype)
    ]
    numeric_columns = config.get("numeric_columns", [])
    categorical_columns = config.get("categorical_columns", [])
    if not isinstance(numeric_columns, list) or not isinstance(categorical_columns, list):
        raise WorkflowExecutionError("Selected summary columns must be lists.")
    if selection == "automatic":
        numeric_columns, categorical_columns = numeric_types, categorical_types
    else:
        if any(column not in frame.columns for column in numeric_columns + categorical_columns):
            raise WorkflowExecutionError("A selected summary column does not exist in the incoming dataset.")
        if any(column not in numeric_types for column in numeric_columns):
            raise WorkflowExecutionError("Select numeric columns only in the numeric columns setting.")
        if any(column not in categorical_types for column in categorical_columns):
            raise WorkflowExecutionError("Select text, category, or boolean columns only in the categorical columns setting.")

    requested_numeric = config.get("numeric_statistics", list(NUMERIC_SUMMARY_STATISTICS))
    requested_categorical = config.get("categorical_statistics", list(CATEGORICAL_SUMMARY_STATISTICS))
    if not isinstance(requested_numeric, list) or any(item not in NUMERIC_SUMMARY_STATISTICS for item in requested_numeric):
        raise WorkflowExecutionError("Choose supported numerical summary statistics.")
    if not isinstance(requested_categorical, list) or any(item not in CATEGORICAL_SUMMARY_STATISTICS for item in requested_categorical):
        raise WorkflowExecutionError("Choose supported categorical summary statistics.")

    rows: list[dict[str, Any]] = []

    def add_metric(summary_type: str, column: Any, statistic: str, value: Any) -> None:
        rows.append({
            "summary_type": summary_type,
            "column": str(column),
            "statistic": statistic,
            "value": value,
            "category": None,
            "frequency": None,
            "percentage": None,
            "top_rank": None,
        })

    for column in numeric_columns:
        series = frame[column]
        valid = series.dropna()
        try:
            modes = valid.mode(dropna=True)
            q1, q3 = valid.quantile(.25), valid.quantile(.75)
            statistics = {
                "count": int(valid.count()),
                "missing_values": int(series.isna().sum()),
                "mean": valid.mean(),
                "median": valid.median(),
                "mode": modes.iloc[0] if not modes.empty else None,
                "minimum": valid.min() if not valid.empty else None,
                "maximum": valid.max() if not valid.empty else None,
                "range": valid.max() - valid.min() if not valid.empty else None,
                "standard_deviation": valid.std(),
                "variance": valid.var(),
                "q1": q1,
                "q3": q3,
                "iqr": q3 - q1,
                "sum": valid.sum(),
                "skewness": valid.skew(),
                "kurtosis": valid.kurt(),
            }
        except (TypeError, ValueError, OverflowError) as exc:
            raise WorkflowExecutionError(f"Could not calculate numeric statistics for column {column}.") from exc
        for statistic in requested_numeric:
            add_metric("numerical", column, statistic, _summary_number(statistics[statistic], precision))

    for column in categorical_columns:
        series = frame[column]
        valid = series.dropna()
        try:
            frequencies = valid.value_counts(dropna=True, sort=True)
            modes = valid.mode(dropna=True)
            unique_values = valid.unique().tolist()
            statistics = {
                "count": int(valid.count()),
                "missing_values": int(series.isna().sum()),
                "unique_values": unique_values,
                "distinct_categories": int(valid.nunique(dropna=True)),
                "mode": modes.iloc[0] if not modes.empty else None,
            }
        except (TypeError, ValueError, OverflowError) as exc:
            raise WorkflowExecutionError(f"Could not calculate categorical statistics for column {column}.") from exc
        for statistic in requested_categorical:
            if statistic in statistics:
                add_metric("categorical", column, statistic, statistics[statistic])
        if "frequency" in requested_categorical or "percentage" in requested_categorical:
            top_values = set(frequencies.head(top_categories).index.tolist())
            denominator = int(valid.count())
            for value, frequency in frequencies.items():
                rank = frequencies.index.get_loc(value) + 1
                rows.append({
                    "summary_type": "categorical",
                    "column": str(column),
                    "statistic": "category",
                    "value": value,
                    "category": value,
                    "frequency": int(frequency) if "frequency" in requested_categorical else None,
                    "percentage": _summary_number(frequency * 100 / denominator, precision) if denominator and "percentage" in requested_categorical else None,
                    "top_rank": rank if value in top_values else None,
                })

    return pd.DataFrame(rows, columns=SUMMARY_COLUMNS)


def cleaning_node(config: dict[str, Any]) -> dict[str, Any]:
    operation = config.get("operation")
    node_type = {
        "filter_rows": "filter_rows",
        "remove_duplicates": "remove_duplicates",
        "select_columns": "select_columns",
        "rename_column": "rename_columns",
    }.get(operation, "clean_data")
    return {"id": "cleaning-preview", "name": "Cleaning operation", "type": node_type, "config": config}


def transform_node(node: dict[str, Any], inputs: list[pd.DataFrame]) -> pd.DataFrame:
    node_type = node["type"]
    config = node.get("config", {})
    if node_type == "merge_data":
        if len(inputs) == 1 and config.get("second_file_id"):
            raise WorkflowExecutionError(
                "Merge with a second dataset must be connected as a second input node. Connect both inputs to the merge node."
            )
        if len(inputs) != 2:
            raise WorkflowExecutionError("Merge nodes require two connected input datasets.")
        left_on = _column(inputs[0], config.get("left_on"))
        right_on = _column(inputs[1], config.get("right_on"))
        how = config.get("how", "inner")
        if how not in {"inner", "left", "right", "outer"}:
            raise WorkflowExecutionError("Choose inner, left, right, or outer as the merge type.")
        try:
            return inputs[0].merge(inputs[1], left_on=left_on, right_on=right_on, how=how, suffixes=("_left", "_right"))
        except (ValueError, KeyError, pd.errors.MergeError) as exc:
            raise WorkflowExecutionError(f"Could not merge the selected datasets: {exc}") from exc

    if len(inputs) != 1:
        raise WorkflowExecutionError(f"{node.get('name', node_type)} requires one input dataset.")
    frame = inputs[0]
    if node_type == "clean_data":
        operation = config.get("operation")
        if not isinstance(operation, str):
            raise WorkflowExecutionError("Choose a cleaning operation.")
        if operation == "trim_text" and not config.get("column"):
            result = frame.copy()
            for name in result.select_dtypes(include=["object", "string"]).columns:
                result[name] = result[name].astype("string").str.strip()
            return result
        try:
            return apply_cleaning(frame, {**config, "operation": operation})[0]
        except CleaningError as exc:
            raise WorkflowExecutionError(str(exc)) from exc
    if node_type == "remove_duplicates":
        columns = config.get("columns") or None
        if columns is not None and (not isinstance(columns, list) or any(name not in frame.columns for name in columns)):
            raise WorkflowExecutionError("Choose existing columns for duplicate detection.")
        return frame.drop_duplicates(subset=columns, keep=config.get("keep", "first"))
    if node_type == "filter_rows":
        return _filter(frame, config)
    if node_type == "select_columns":
        columns = config.get("columns")
        if not isinstance(columns, list) or not columns:
            raise WorkflowExecutionError("Choose at least one column to keep.")
        missing = [name for name in columns if name not in frame.columns]
        if missing:
            raise WorkflowExecutionError(f"Selected column {missing[0]} does not exist.")
        return frame.loc[:, columns].copy()
    if node_type == "rename_columns":
        old, new = config.get("from"), config.get("to")
        if old not in frame.columns or not isinstance(new, str) or not new.strip():
            raise WorkflowExecutionError("Choose an existing column and enter its new name.")
        new = new.strip()
        if new != old and new in frame.columns:
            raise WorkflowExecutionError(f"Column name {new} already exists.")
        return frame.rename(columns={old: new})
    if node_type == "aggregate_data":
        group_by = config.get("group_by")
        if isinstance(group_by, str):
            group_by = [group_by]
        if not isinstance(group_by, list) or not group_by or any(name not in frame.columns for name in group_by):
            raise WorkflowExecutionError("Choose existing columns to group by.")
        operation = config.get("operation")
        operation = "mean" if operation == "average" else operation
        column = config.get("column")
        if operation == "count" and not column:
            return frame.groupby(group_by, dropna=False).size().rename("count").reset_index()
        column = _column(frame, column)
        if operation not in {"sum", "mean", "count", "min", "max", "median"}:
            raise WorkflowExecutionError("Choose a supported aggregation operation.")
        if operation in {"sum", "mean", "median"} and not pd.api.types.is_numeric_dtype(frame[column]):
            raise WorkflowExecutionError(f"{operation.title()} requires a numeric value column.")
        return frame.groupby(group_by, dropna=False, as_index=False).agg(**{column: (column, operation)})
    if node_type == "statistical_summary":
        return statistical_summary(frame, config)
    raise WorkflowExecutionError(f"Unsupported transformation node: {node_type}.")


class WorkflowExecutionService:
    def __init__(self, storage: FileSystemStorage):
        self.storage = storage
        self.metadata = MetadataService(storage)
        self.datasets = DatasetService(storage)
        self.connections = ConnectionManager(storage)
        self.external_sources = ExternalSourceService()

    def _read_input(self, node: dict[str, Any]) -> tuple[pd.DataFrame, str, dict[str, Any]]:
        node_type = node["type"]
        config = node.get("config", {})
        if node_type in FILE_INPUT_TYPES:
            source = self.metadata.get_file(config.get("file_id"))
            if not source or source.get("status") != "uploaded":
                raise WorkflowExecutionError("The selected input dataset no longer exists.", node["id"])
            return self.datasets.read(source), source["filename"], {}
        connection_id = config.get("connection_id")
        try:
            connection, secrets = self.connections.get_with_secrets(connection_id)
            frame, metrics = self.external_sources.extract(connection, secrets, config, MAX_EXTRACT_ROWS)
        except (ExternalSourceError, ValueError, RuntimeError) as exc:
            raise WorkflowExecutionError(str(exc), node["id"]) from None
        return frame, connection["name"], metrics

    def _validate(self, workflow: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str], dict[str, str]]:
        ordered_nodes, errors = plan_workflow(workflow, self.metadata)
        node_errors: dict[str, str] = {}
        if errors:
            for error in errors:
                for node in workflow.get("nodes", []):
                    if node.get("name") and str(node["name"]) in error:
                        node_errors[node["id"]] = error
            return ordered_nodes, errors, node_errors

        frame_by_node: dict[str, pd.DataFrame] = {}
        edges = workflow.get("edges", [])
        for node in ordered_nodes:
            node_id, node_type = node["id"], node["type"]
            parents = [edge["source"] for edge in edges if edge["target"] == node_id]
            try:
                if node_type in INPUT_TYPES:
                    frame_by_node[node_id], _source_name, _metrics = self._read_input(node)
                    continue
                inputs = [frame_by_node[parent_id] for parent_id in parents]
                if node_type in OUTPUT_TYPES:
                    frame_by_node[node_id] = inputs[0]
                elif node_type in PREVIEW_TYPES:
                    frame_by_node[node_id] = inputs[0]
                else:
                    frame_by_node[node_id] = transform_node(node, inputs)
            except Exception as exc:
                message = str(exc) if isinstance(exc, WorkflowExecutionError) else f"Could not inspect input data: {exc}"
                node_errors[node_id] = message
                errors.append(f"{node.get('name', node_id)}: {message}")
                break
        return ordered_nodes, list(dict.fromkeys(errors)), node_errors

    def validate(self, workflow: dict[str, Any]) -> dict[str, Any]:
        ordered_nodes, errors, node_errors = self._validate(workflow)
        return {
            "valid": not errors,
            "errors": errors,
            "node_errors": node_errors,
            "execution_order": [node["id"] for node in ordered_nodes],
        }

    def _record_validation_failure(
        self,
        record: dict[str, Any],
        errors: list[str],
        node_errors: dict[str, str],
    ) -> None:
        for node_id, message in node_errors.items():
            record["node_statuses"][node_id].update({"status": "failed", "error": message})
        for status in record["node_statuses"].values():
            if status["status"] == "pending":
                status["status"] = "skipped"
        record.update({
            "completed_at": utc_now(),
            "status": "failed",
            "error": "Workflow validation failed: " + " ".join(errors),
            "failing_node_id": next(iter(node_errors), None),
            "summary": {"duration_seconds": 0},
        })
        self.metadata.save_execution(record)

    @staticmethod
    def _new_record(workflow: dict[str, Any], execution_id: str) -> dict[str, Any]:
        return {
            "execution_id": execution_id,
            "workflow_id": workflow["workflow_id"],
            "workflow_name": workflow["name"],
            "owner_id": workflow.get("owner_id"),
            "started_at": utc_now(),
            "completed_at": None,
            "status": "running",
            "input_file_ids": [],
            "output_file_ids": [],
            "operations": [],
            "previews": {},
            "node_statuses": {
                node["id"]: {
                    "status": "pending",
                    "node_name": node.get("name", node["id"]),
                    "node_type": node.get("type"),
                    "output_available": False,
                }
                for node in workflow.get("nodes", [])
            },
            "summary": {},
            "error": None,
            "failing_node_id": None,
        }

    def execute(self, workflow: dict[str, Any]) -> dict[str, Any]:
        if not _execution_lock.acquire(blocking=False):
            raise WorkflowExecutionError("Another workflow is currently executing. Try again shortly.")
        try:
            record = self._new_record(workflow, uuid4().hex)
            ordered_nodes, errors, node_errors = self._validate(workflow)
            if errors:
                self._record_validation_failure(record, errors, node_errors)
                failing_node = next(iter(node_errors), None)
                raise WorkflowExecutionError("Workflow validation failed: " + " ".join(errors), failing_node)
            return self._execute_locked(workflow, ordered_nodes, record)
        finally:
            _execution_lock.release()

    def start(self, workflow: dict[str, Any]) -> dict[str, Any]:
        if not _execution_lock.acquire(blocking=False):
            raise WorkflowExecutionError("Another workflow is currently executing. Try again shortly.")
        try:
            record = self._new_record(workflow, uuid4().hex)
            ordered_nodes, errors, node_errors = self._validate(workflow)
            if errors:
                self._record_validation_failure(record, errors, node_errors)
                failing_node = next(iter(node_errors), None)
                raise WorkflowExecutionError("Workflow validation failed: " + " ".join(errors), failing_node)
            self.metadata.save_execution(record)
            worker = Thread(target=self._run_background, args=(workflow, ordered_nodes, record), daemon=True)
            try:
                worker.start()
            except Exception:
                record.update({
                    "status": "failed",
                    "completed_at": utc_now(),
                    "error": "Workflow execution could not be started.",
                    "summary": {"duration_seconds": 0},
                })
                self.metadata.save_execution(record)
                raise
            return record
        except Exception:
            _execution_lock.release()
            raise

    def _run_background(self, workflow: dict[str, Any], ordered_nodes: list[dict[str, Any]], record: dict[str, Any]) -> None:
        try:
            self._execute_locked(workflow, ordered_nodes, record)
        except Exception as exc:
            _logger.exception("Background workflow execution failed: %s", exc)
        finally:
            _execution_lock.release()

    def _execute_locked(
        self,
        workflow: dict[str, Any],
        ordered_nodes: list[dict[str, Any]],
        record: dict[str, Any],
    ) -> dict[str, Any]:

        execution_id = record["execution_id"]
        started = record["started_at"]
        started_clock = time.perf_counter()
        self.metadata.save_execution(record)
        frame_by_node: dict[str, pd.DataFrame] = {}
        output_records: list[dict[str, Any]] = []
        created_files: list[tuple[str, str]] = []
        edges = workflow.get("edges", [])
        node_by_id = {node["id"]: node for node in workflow["nodes"]}

        def input_ancestors(node_id: str) -> list[dict[str, Any]]:
            ancestors = set()
            stack = [node_id]
            while stack:
                ancestor_id = stack.pop()
                if ancestor_id in ancestors:
                    continue
                ancestors.add(ancestor_id)
                stack.extend(edge["source"] for edge in edges if edge["target"] == ancestor_id)
                return [
                node for node in ordered_nodes
                if node["id"] in ancestors and node["type"] in INPUT_TYPES
            ]

        current_node_id = None
        try:
            node_failures: list[WorkflowExecutionError] = []
            for node in ordered_nodes:
                node_id, node_type = node["id"], node["type"]
                current_node_id = node_id
                parent_ids = [edge["source"] for edge in edges if edge["target"] == node_id]
                if any(record["node_statuses"][parent_id]["status"] != "success" for parent_id in parent_ids):
                    record["node_statuses"][node_id].update({
                        "status": "skipped",
                        "error": "A connected input node did not complete successfully.",
                    })
                    self.metadata.save_execution(record)
                    continue

                record["node_statuses"][node_id].update({"status": "running"})
                self.metadata.save_execution(record)
                try:
                    if node_type in INPUT_TYPES:
                        frame_by_node[node_id], source_name, source_metrics = self._read_input(node)
                        if node_type in FILE_INPUT_TYPES:
                            file_id = node.get("config", {}).get("file_id")
                            if file_id not in record["input_file_ids"]:
                                record["input_file_ids"].append(file_id)
                        else:
                            record.setdefault("input_sources", []).append({
                                "connection_id": node.get("config", {}).get("connection_id"),
                                "name": source_name,
                            })
                            record["node_statuses"][node_id]["source_metrics"] = source_metrics
                        rows = len(frame_by_node[node_id])
                    else:
                        inputs = [frame_by_node[parent_id] for parent_id in parent_ids]
                        if node_type in OUTPUT_TYPES:
                            frame = inputs[0]
                            frame_by_node[node_id] = frame
                            extension = f".{OUTPUT_TYPES[node_type]}"
                            base_name = secure_filename(str(node.get("config", {}).get("filename", "")).strip())
                            if not base_name:
                                raise WorkflowExecutionError("Enter a valid output filename.", node_id)
                            file_id = node.get("config", {}).get("dataset_id") or self.metadata.stable_dataset_id(workflow["workflow_id"], node_id)
                            managed_filename = f"{base_name}{extension}"
                            self.datasets.write_processed(frame, extension, file_id)
                            created_files.append((file_id, extension))
                            output = {
                                "file_id": file_id,
                                "dataset_id": file_id,
                                "owner_id": record.get("owner_id"),
                                "filename": managed_filename,
                                "file_type": extension[1:],
                                "file_size": self.storage.processed_path(file_id, extension).stat().st_size,
                                "uploaded_at": utc_now(),
                                "last_updated": utc_now(),
                                "status": "processed",
                                "stored_name": f"{file_id}{extension}",
                                "source_file_ids": [node["config"]["file_id"] for node in input_ancestors(node_id) if node["type"] in FILE_INPUT_TYPES],
                                "workflow_id": workflow["workflow_id"],
                                "output_node_id": node_id,
                                "execution_id": execution_id,
                                "row_count": int(len(frame)),
                                "column_count": int(len(frame.columns)),
                                "source_type": "processed",
                            }
                            output_records.append(output)
                            rows = len(frame)
                        elif node_type in PREVIEW_TYPES:
                            frame = inputs[0]
                            frame_by_node[node_id] = frame
                            rows = len(frame)
                        else:
                            frame_by_node[node_id] = transform_node(node, inputs)
                            rows = len(frame_by_node[node_id])

                    frame = frame_by_node[node_id]
                    completed_at = utc_now()
                    column_metadata = [
                        {
                            "name": str(column),
                            "dtype": str(frame[column].dtype),
                            "missing": int(frame[column].isna().sum()),
                        }
                        for column in frame.columns
                    ]
                    source_names = [
                        source["filename"] if ancestor["type"] in FILE_INPUT_TYPES else self.metadata.get_connection(ancestor.get("config", {}).get("connection_id"))["name"]
                        for ancestor in input_ancestors(node_id)
                        if (
                            (source := self.metadata.get_file(ancestor.get("config", {}).get("file_id")))
                            if ancestor["type"] in FILE_INPUT_TYPES
                            else self.metadata.get_connection(ancestor.get("config", {}).get("connection_id"))
                        )
                    ]
                    self.datasets.write_preview(frame, execution_id, node_id)
                    output_metadata = {
                        "node_id": node_id,
                        "node_name": node.get("name", node_id),
                        "node_type": node_type,
                        "status": "success",
                        "row_count": int(len(frame)),
                        "column_count": int(len(frame.columns)),
                        "columns": column_metadata,
                        "missing_cells": int(frame.isna().sum().sum()),
                        "dataset_name": ", ".join(sorted(set(source_names))) or node.get("name", "Workflow output"),
                        "execution_id": execution_id,
                        "executed_at": completed_at,
                        "output_ref": {"kind": "node_preview", "node_id": node_id},
                    }
                    record["previews"][node_id] = output_metadata
                    record["operations"].append({
                        "node_id": node_id,
                        "node_name": node.get("name", node_id),
                        "type": node_type,
                        "rows": rows,
                    })
                    record["node_statuses"][node_id].update({
                        "status": "success",
                        "rows": rows,
                        "columns": int(len(frame.columns)),
                        "column_metadata": column_metadata,
                        "output_available": True,
                        "executed_at": completed_at,
                    })
                    self.metadata.save_execution(record)
                except Exception as exc:
                    failure = exc if isinstance(exc, WorkflowExecutionError) else WorkflowExecutionError(
                        f"Node {node.get('name', node_id)} failed: {exc}",
                        node_id,
                    )
                    failure.node_id = node_id
                    node_failures.append(failure)
                    record["node_statuses"][node_id].update({"status": "failed", "error": str(failure)})
                    self.metadata.save_execution(record)

            if node_failures:
                raise node_failures[0]

            for output in output_records:
                self.metadata.save_file(output)
            input_frames = [frame for node_id, frame in frame_by_node.items() if node_by_id[node_id]["type"] in INPUT_TYPES]
            output_frames = [frame_by_node[node["id"]] for node in ordered_nodes if node["type"] in OUTPUT_TYPES and node["id"] in frame_by_node]
            record.update({
                "completed_at": utc_now(),
                "status": "completed",
                "output_file_ids": [item["file_id"] for item in output_records],
                "summary": {
                    "input_rows": sum(len(frame) for frame in input_frames),
                    "final_rows": sum(len(frame) for frame in output_frames),
                    "input_columns": max((len(frame.columns) for frame in input_frames), default=0),
                    "final_columns": max((len(frame.columns) for frame in output_frames), default=0),
                    "duration_seconds": round(time.perf_counter() - started_clock, 4),
                    "input_datasets": [
                        self.metadata.get_file(file_id)["filename"] for file_id in record["input_file_ids"]
                    ] + [item["name"] for item in record.get("input_sources", [])],
                    "output_datasets": [item["filename"] for item in output_records],
                },
            })
            self.metadata.save_execution(record)
            return record
        except Exception as exc:
            failing_node_id = getattr(exc, "node_id", None) or current_node_id
            if failing_node_id in record["node_statuses"]:
                record["node_statuses"][failing_node_id].update({"status": "failed", "error": str(exc)})
            for node_id, status in record["node_statuses"].items():
                if status["status"] == "pending":
                    status["status"] = "skipped"
            for file_id, extension in created_files:
                self.storage.delete_processed(file_id, extension)
            record.update({
                "completed_at": utc_now(),
                "status": "failed",
                "output_file_ids": [],
                "error": str(exc),
                "failing_node_id": failing_node_id,
                "summary": {"duration_seconds": round(time.perf_counter() - started_clock, 4)},
            })
            self.metadata.save_execution(record)
            if isinstance(exc, WorkflowExecutionError):
                if exc.node_id is None:
                    exc.node_id = failing_node_id
                raise
            raise WorkflowExecutionError("Workflow execution failed. Check node settings and dataset contents.") from exc
