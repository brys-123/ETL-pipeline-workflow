import io

import pandas as pd
import pytest

from simple_etl import create_app
from simple_etl.services.metadata_service import MetadataService


@pytest.fixture
def summary_client(tmp_path):
    app = create_app({
        "TESTING": True,
        "DEBUG": False,
        "STORAGE_ROOT": tmp_path / "storage",
        "MAX_UPLOAD_SIZE_MB": 2,
    })
    return app.test_client(), app.extensions["etl_storage"]


@pytest.mark.parametrize(
    ("output_type", "extension"),
    [("csv_output", ".csv"), ("excel_output", ".xlsx"), ("json_output", ".json")],
)
def test_summary_node_calculates_real_statistics_and_exports(summary_client, output_type, extension):
    client, storage = summary_client
    content = b"sales,region,constant,empty\n1,North,5,\n2,South,5,\n3,North,5,\n4,,5,\n,South,5,\n"
    upload = client.post(
        "/api/files/upload",
        data={"file": (io.BytesIO(content), "summary-input.csv")},
        content_type="multipart/form-data",
    )
    assert upload.status_code == 201, upload.json
    file_id = upload.json["file_id"]

    workflow = client.post("/api/workflows", json={
        "name": "Statistical summary test",
        "nodes": [
            {"id": "input", "type": "csv_input", "config": {"file_id": file_id}},
            {"id": "summary", "type": "statistical_summary", "config": {"column_selection": "automatic"}},
            {"id": "output", "type": output_type, "config": {"filename": "summary-result"}},
        ],
        "edges": [
            {"id": "input-summary", "source": "input", "target": "summary"},
            {"id": "summary-output", "source": "summary", "target": "output"},
        ],
    })
    assert workflow.status_code == 201, workflow.json

    result = client.post(f"/api/workflows/{workflow.json['workflow_id']}/execute")
    assert result.status_code == 200, result.json
    execution = result.json
    assert execution["status"] == "completed"
    assert execution["node_statuses"]["summary"]["output_available"] is True
    values = []
    for summary_type in ("numerical", "categorical"):
        preview = client.get(
            f"/api/workflows/{workflow.json['workflow_id']}/nodes/summary/preview"
            f"?execution_id={execution['execution_id']}&summary_type={summary_type}&page_size=100"
        )
        assert preview.status_code == 200, preview.json
        columns = preview.json["columns"]
        values.extend(dict(zip(columns, row)) for row in preview.json["rows"])

    def metric(summary_type, column, statistic):
        return next(
            row["value"] for row in values
            if row["summary_type"] == summary_type
            and row["column"] == column
            and row["statistic"] == statistic
        )

    assert metric("numerical", "sales", "count") == 4
    assert metric("numerical", "sales", "missing_values") == 1
    assert metric("numerical", "sales", "mean") == 2.5
    assert metric("numerical", "sales", "median") == 2.5
    assert metric("numerical", "sales", "minimum") == 1
    assert metric("numerical", "sales", "maximum") == 4
    assert metric("numerical", "sales", "q1") == 1.75
    assert metric("numerical", "sales", "q3") == 3.25
    assert metric("numerical", "constant", "standard_deviation") == 0
    assert metric("numerical", "empty", "count") == 0
    assert metric("numerical", "empty", "missing_values") == 5

    category_rows = [
        row for row in values
        if row["summary_type"] == "categorical"
        and row["column"] == "region"
        and row["statistic"] == "category"
    ]
    assert {(row["category"], row["frequency"], row["percentage"]) for row in category_rows} == {
        ("North", 2, 50.0),
        ("South", 2, 50.0),
    }
    assert {row["top_rank"] for row in category_rows} == {1, 2}
    assert storage.upload_path(file_id, ".csv").read_bytes() == content

    output = execution["output_file_ids"][0]
    record = next(item for item in execution["summary"]["output_datasets"] if item)
    assert record.endswith(extension)
    output_record = MetadataService(storage).get_file(output)
    assert output_record["stored_name"].endswith(extension)
    assert storage.processed_path(output, extension).is_file()
    if extension == ".csv":
        exported = pd.read_csv(storage.processed_path(output, extension))
    elif extension == ".xlsx":
        exported = pd.read_excel(storage.processed_path(output, extension))
    else:
        exported = pd.read_json(storage.processed_path(output, extension))
    assert set(exported["summary_type"]) == {"numerical", "categorical"}
