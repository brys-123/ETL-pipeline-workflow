import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .storage_service import FileSystemStorage

MAX_PREVIEW_PAGE_SIZE = 100


def _json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, default=str)
    if pd.isna(value):
        return None
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


class DatasetService:
    def __init__(self, storage: FileSystemStorage):
        self.storage = storage

    def path_for(self, record: dict[str, Any]) -> Path:
        file_id = record.get("file_id", "")
        extension = f".{record.get('file_type', '')}"
        if record.get("status") == "processed":
            return self.storage.processed_path(file_id, extension)
        if record.get("status") == "preview":
            return self.storage.preview_path(record.get("execution_id", ""), record.get("node_id", ""))
        return self.storage.upload_path(file_id, extension)

    def read(self, record: dict[str, Any]) -> pd.DataFrame:
        path = self.path_for(record)
        file_type = record.get("file_type")
        if record.get("status") == "preview":
            return pd.read_json(path, orient="table")
        if file_type == "csv":
            return pd.read_csv(path, low_memory=False)
        if file_type == "xlsx":
            return pd.read_excel(path, engine="openpyxl")
        if file_type == "json":
            try:
                return pd.read_json(path)
            except ValueError:
                value = json.loads(path.read_text(encoding="utf-8-sig"))
                if isinstance(value, list) and all(isinstance(item, dict) for item in value):
                    return pd.DataFrame.from_records(value)
                if isinstance(value, list):
                    return pd.DataFrame(value)
                if isinstance(value, dict):
                    return pd.DataFrame([value])
                raise ValueError("JSON datasets must contain an object or array.")
        raise ValueError("Unsupported dataset type.")

    @staticmethod
    def _column_kind(series: pd.Series) -> str:
        if pd.api.types.is_datetime64_any_dtype(series.dtype):
            return "date"
        if pd.api.types.is_numeric_dtype(series.dtype) and not pd.api.types.is_bool_dtype(series.dtype):
            return "numeric"
        if pd.api.types.is_bool_dtype(series.dtype):
            return "boolean"
        return "text"

    def inspect(self, record: dict[str, Any]) -> dict[str, Any]:
        frame = self.read(record)
        schema = []
        numeric_columns = []
        text_columns = []
        date_columns = []
        for column in frame.columns:
            series = frame[column]
            kind = self._column_kind(series)
            if kind == "numeric":
                numeric_columns.append(str(column))
            elif kind == "date":
                date_columns.append(str(column))
            else:
                text_columns.append(str(column))
            schema.append({
                "name": str(column),
                "dtype": str(series.dtype),
                "kind": kind,
                "missing": int(series.isna().sum()),
                "unique": int(series.nunique(dropna=True)),
            })

        numeric_summary: dict[str, Any] = {}
        numeric = frame.select_dtypes(include="number")
        if not numeric.empty:
            numeric_summary = {
                str(column): {
                    key: _json_value(value)
                    for key, value in numeric[column].describe().to_dict().items()
                }
                for column in numeric.columns
            }
        return {
            "file_id": record["file_id"],
            "filename": record["filename"],
            "file_type": record["file_type"],
            "file_size": record["file_size"],
            "uploaded_at": record.get("uploaded_at"),
            "rows": int(len(frame)),
            "columns": int(len(frame.columns)),
            "missing_cells": int(frame.isna().sum().sum()),
            "duplicate_rows": int(frame.duplicated().sum()),
            "numeric_columns": numeric_columns,
            "text_columns": text_columns,
            "date_columns": date_columns,
            "schema": schema,
            "numeric_summary": numeric_summary,
        }

    def preview(
        self,
        record: dict[str, Any],
        page: int = 1,
        page_size: int = 100,
        query: str = "",
    ) -> dict[str, Any]:
        if page < 1:
            raise ValueError("Page must be a positive integer.")
        if page_size < 1 or page_size > MAX_PREVIEW_PAGE_SIZE:
            raise ValueError(f"Page size must be between 1 and {MAX_PREVIEW_PAGE_SIZE}.")
        frame = self.read(record)
        if query:
            mask = frame.astype("string").apply(
                lambda column: column.str.contains(query, case=False, na=False, regex=False)
            ).any(axis=1)
            frame = frame.loc[mask]

        total_rows = int(len(frame))
        offset = (page - 1) * page_size
        rows = [
            [
                (str(value) if record.get("file_type") == "csv" and not pd.isna(value) else _json_value(value))
                for value in row
            ]
            for row in frame.iloc[offset:offset + page_size].itertuples(index=False, name=None)
        ]
        return {
            "filename": record["filename"],
            "columns": [str(column) for column in frame.columns],
            "rows": rows,
            "page": page,
            "page_size": page_size,
            "total_rows": total_rows,
            "total_pages": max(1, (total_rows + page_size - 1) // page_size),
            "has_more": offset + len(rows) < total_rows,
        }

    def write_processed(self, frame: pd.DataFrame, extension: str, file_id: str) -> None:
        path = self.storage.processed_path(file_id, extension)
        if extension == ".csv":
            frame.to_csv(path, index=False)
        elif extension == ".xlsx":
            frame.to_excel(path, index=False, engine="openpyxl")
        elif extension == ".json":
            frame.to_json(path, orient="records", force_ascii=False, date_format="iso")
        else:
            raise ValueError("Unsupported output format.")

    def write_preview(self, frame: pd.DataFrame, execution_id: str, node_id: str) -> None:
        frame.to_json(self.storage.preview_path(execution_id, node_id), orient="table", date_format="iso")
