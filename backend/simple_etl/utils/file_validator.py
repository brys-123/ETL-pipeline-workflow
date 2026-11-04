import csv
import io
import json
import zipfile
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException
from werkzeug.utils import secure_filename

ALLOWED_EXTENSIONS = {".csv", ".xlsx", ".json"}


def validate_dataset(filename: str, content: bytes) -> tuple[str, str]:
    safe_name = secure_filename(filename)
    extension = Path(safe_name).suffix.lower()
    if not safe_name or extension not in ALLOWED_EXTENSIONS:
        raise ValueError("Choose a CSV, XLSX, or JSON dataset.")
    if not content:
        raise ValueError("The uploaded file is empty.")

    try:
        if extension == ".json":
            value = json.loads(content.decode("utf-8-sig"))
            if not isinstance(value, (list, dict)):
                raise ValueError("JSON datasets must contain an object or array.")
        elif extension == ".csv":
            text = content[:65536].decode("utf-8-sig")
            if not text.strip():
                raise ValueError("The CSV dataset is empty.")
            sample = text[:8192]
            try:
                dialect = csv.Sniffer().sniff(sample)
            except csv.Error:
                dialect = csv.excel
            if not next(csv.reader(io.StringIO(text), dialect), None):
                raise ValueError("The CSV dataset has no columns.")
        else:
            workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
            try:
                if not workbook.sheetnames:
                    raise ValueError("The Excel workbook has no worksheets.")
            finally:
                workbook.close()
    except (UnicodeDecodeError, json.JSONDecodeError, csv.Error, OSError, KeyError, zipfile.BadZipFile, InvalidFileException) as exc:
        raise ValueError("The file contents do not match a valid supported dataset.") from exc

    return safe_name, extension