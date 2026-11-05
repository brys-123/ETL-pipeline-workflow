from typing import Any

import pandas as pd


class CleaningError(ValueError):
    pass


def _column(frame: pd.DataFrame, config: dict[str, Any]) -> str:
    value = config.get("column")
    if not isinstance(value, str) or value not in frame.columns:
        raise CleaningError("Choose a column that exists in the dataset.")
    return value


def quality_stats(frame: pd.DataFrame) -> dict[str, int]:
    return {
        "rows": int(len(frame)),
        "columns": int(len(frame.columns)),
        "missing_cells": int(frame.isna().sum().sum()),
        "duplicate_rows": int(frame.duplicated().sum()),
    }


def apply_cleaning(frame: pd.DataFrame, config: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, Any]]:
    if not isinstance(config, dict):
        raise CleaningError("Cleaning settings must be an object.")
    operation = config.get("operation")
    result = frame.copy()
    before = quality_stats(frame)
    affected = 0

    if operation == "remove_missing_rows":
        result = result.dropna()
        affected = len(frame) - len(result)
    elif operation == "remove_missing_columns":
        result = result.dropna(axis=1)
        affected = len(frame.columns) - len(result.columns)
    elif operation == "fill_missing":
        method = config.get("method", "constant")
        columns = config.get("columns", [config.get("column")] if config.get("column") else list(result.columns))
        if not isinstance(columns, list) or not columns or any(column not in result.columns for column in columns):
            raise CleaningError("Choose one or more columns that exist in the dataset.")
        if method == "constant":
            value = config.get("value", "")
            for name in columns:
                missing = int(result[name].isna().sum())
                fill_value = value
                if pd.api.types.is_numeric_dtype(result[name]) and isinstance(value, str):
                    try:
                        fill_value = pd.to_numeric(value, errors="raise")
                    except (TypeError, ValueError):
                        result[name] = result[name].astype("object")
                result[name] = result[name].fillna(fill_value)
                affected += missing
        elif method in {"mean", "median"}:
            for name in columns:
                if not pd.api.types.is_numeric_dtype(result[name]):
                    raise CleaningError(f"{method.title()} filling is only available for numeric columns ({name}).")
                fill_value = getattr(result[name], method)()
                if pd.isna(fill_value):
                    raise CleaningError(f"Column {name} has no values to calculate a {method}.")
                affected += int(result[name].isna().sum())
                result[name] = result[name].fillna(fill_value)
        elif method == "mode":
            for name in columns:
                modes = result[name].mode(dropna=True)
                if modes.empty:
                    raise CleaningError(f"Column {name} has no values to calculate a mode.")
                affected += int(result[name].isna().sum())
                result[name] = result[name].fillna(modes.iloc[0])
        else:
            raise CleaningError("Choose a supported missing-value fill method.")
    elif operation == "remove_duplicates":
        subset = config.get("columns") or None
        if subset is not None and (not isinstance(subset, list) or any(name not in result.columns for name in subset)):
            raise CleaningError("Duplicate comparison columns must exist in the dataset.")
        result = result.drop_duplicates(subset=subset, keep=config.get("keep", "first"))
        affected = len(frame) - len(result)
    elif operation in {"trim_text", "uppercase", "lowercase", "titlecase", "replace_text", "remove_unwanted_characters"}:
        name = _column(result, config)
        if not (pd.api.types.is_string_dtype(result[name]) or result[name].dtype == object):
            raise CleaningError(f"Column {name} does not contain text values.")
        original = result[name].copy()
        values = result[name].astype("string")
        if operation == "trim_text":
            values = values.str.strip()
        elif operation == "uppercase":
            values = values.str.upper()
        elif operation == "lowercase":
            values = values.str.lower()
        elif operation == "titlecase":
            values = values.str.title()
        elif operation == "replace_text":
            find = config.get("find")
            if not isinstance(find, str) or not find:
                raise CleaningError("Enter text to find.")
            values = values.str.replace(find, str(config.get("replace", "")), regex=False)
        else:
            values = values.str.replace(r"[^A-Za-z0-9\s._-]", "", regex=True)
        result[name] = values
        affected = int((original.fillna("").astype(str) != values.fillna("").astype(str)).sum())
    elif operation == "convert_type":
        name = _column(result, config)
        target_type = config.get("target_type")
        source = result[name]
        if target_type == "integer":
            converted = pd.to_numeric(source, errors="coerce")
            invalid = source.notna() & converted.isna()
            fractional = converted.notna() & (converted % 1 != 0)
            invalid_count = int((invalid | fractional).sum())
            if invalid_count:
                raise CleaningError(f"{invalid_count} values in {name} cannot be converted to integers.")
            result[name] = converted.astype("Int64")
        elif target_type == "float":
            converted = pd.to_numeric(source, errors="coerce")
            invalid_count = int((source.notna() & converted.isna()).sum())
            if invalid_count:
                raise CleaningError(f"{invalid_count} values in {name} cannot be converted to numbers.")
            result[name] = converted
        elif target_type == "string":
            result[name] = source.astype("string")
        elif target_type == "datetime":
            converted = pd.to_datetime(source, errors="coerce")
            invalid_count = int((source.notna() & converted.isna()).sum())
            if invalid_count:
                raise CleaningError(f"{invalid_count} values in {name} cannot be converted to dates.")
            result[name] = converted
        else:
            raise CleaningError("Choose integer, float, string, or datetime as the target type.")
        affected = int((source.astype(str) != result[name].astype(str)).sum())
    elif operation == "remove_columns":
        columns = config.get("columns")
        if not isinstance(columns, list) or not columns or any(name not in result.columns for name in columns):
            raise CleaningError("Choose one or more existing columns to remove.")
        result = result.drop(columns=columns)
        affected = len(frame) * len(columns)
    elif operation == "select_columns":
        columns = config.get("columns")
        if not isinstance(columns, list) or not columns or any(name not in result.columns for name in columns):
            raise CleaningError("Choose one or more existing columns to keep.")
        result = result.loc[:, columns]
        affected = len(frame.columns) - len(result.columns)
    elif operation == "rename_column":
        old_name, new_name = config.get("from"), config.get("to")
        if old_name not in result.columns or not isinstance(new_name, str) or not new_name.strip():
            raise CleaningError("Choose an existing column and enter a new name.")
        new_name = new_name.strip()
        if new_name != old_name and new_name in result.columns:
            raise CleaningError("The new column name already exists.")
        result = result.rename(columns={old_name: new_name})
        affected = len(result)
    elif operation == "reorder_columns":
        columns = config.get("columns")
        if not isinstance(columns, list) or set(columns) != set(result.columns) or len(columns) != len(result.columns):
            raise CleaningError("Reordered columns must include every dataset column exactly once.")
        result = result.loc[:, columns]
    elif operation in {"inspect_outliers", "remove_outliers"}:
        name = _column(result, config)
        if not pd.api.types.is_numeric_dtype(result[name]):
            raise CleaningError(f"Column {name} must be numeric to inspect outliers.")
        q1, q3 = result[name].quantile([.25, .75])
        spread = q3 - q1
        lower = float(q1 - 1.5 * spread)
        upper = float(q3 + 1.5 * spread)
        mask = result[name].lt(lower) | result[name].gt(upper)
        affected = int(mask.sum())
        if operation == "inspect_outliers":
            return result, {"operation": operation, "affected_records": affected, "lower_bound": lower, "upper_bound": upper, "before": before, "after": before}
        result = result.loc[~mask].copy()
    else:
        raise CleaningError("Choose a supported data-cleaning operation.")

    return result, {
        "operation": operation,
        "affected_records": int(affected),
        "before": before,
        "after": quality_stats(result),
    }
