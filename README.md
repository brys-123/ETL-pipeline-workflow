# Simple ETL Studio

Simple ETL Studio is a local, file-backed workspace for inspecting, cleaning, transforming, and exporting datasets through visual ETL workflows. The application uses Flask, JSON metadata, and the local filesystem; it does not use a database.

## Requirements

- Python 3.11 or newer
- Node.js and npm (for the Dashboard Designer's local visualization libraries)
- Windows PowerShell for the commands below

The Flask server serves both the API and the frontend. Install the frontend packages once so Flask can serve the local charting and PNG-export libraries.

## Install and run

From the project root:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
Set-Location frontend
npm ci
Set-Location ..
Copy-Item .env.example .env
python backend\app.py
```

Open http://127.0.0.1:5000. The API health check is at http://127.0.0.1:5000/api/health.

To stop the development server, press `Ctrl+C` in its PowerShell terminal.

For Vite development, keep the Flask server running and start Vite in a second terminal with `npm run dev` from `frontend`. Vite proxies `/api` requests to `http://127.0.0.1:5000`; set `VITE_API_PROXY_TARGET` if Flask is running at another URL.

## Configuration

The application reads environment variables and an optional root `.env` file.

| Variable | Default | Description |
| --- | --- | --- |
| `STORAGE_MODE` | `local` | `local` or `server` deployment label |
| `STORAGE_ROOT` | `storage` | Root for uploaded data, workflows, metadata, and logs; relative paths resolve from the project root |
| `MAX_UPLOAD_SIZE_MB` | `100` | Per-file upload limit |
| `FRONTEND_ORIGINS` | Local app origins | Comma-separated CORS allowlist for `/api/*` |
| `HOST` | `127.0.0.1` | Flask bind address |
| `PORT` | `5000` | Flask port |
| `FLASK_DEBUG` | `false` | Enables Flask debug mode only when explicitly set to `true` |

For a server deployment, set `STORAGE_MODE=server` and point `STORAGE_ROOT` at a persistent directory outside the application code, for example:

```powershell
$env:STORAGE_MODE = "server"
$env:STORAGE_ROOT = "D:\SimpleETLData"
$env:FLASK_DEBUG = "false"
python backend\app.py
```

The configured storage root contains:

- `uploads/`: original uploaded files
- `processed/`: derived datasets from cleaning operations and workflow exports
- `workflows/`: one JSON file per saved workflow
- `dashboards/`: one JSON file per saved dashboard design
- `logs/`: rotating application log
- `metadata/`: JSON file and execution indexes

Do not place `.env`, uploaded datasets, generated metadata, or logs under source control. The root `.gitignore` excludes these paths.

## Features

- Upload CSV, XLSX, and JSON datasets, individually or in batches, with size and content validation.
- Inspect schema, column types, missing values, duplicates, and numeric statistics; search and paginate dataset previews.
- Apply cleaning operations to derived copies, including missing-value handling, duplicate removal, text normalization, type conversion, column changes, and IQR outlier handling. Source uploads remain unchanged.
- Build workflows with connected input, transformation, merge, preview, and export nodes. Branching is supported, while merge nodes require two connected inputs.
- Validate and run workflows, including filters, column selection and renaming, aggregation, two-input joins, and CSV/XLSX/JSON exports. Runs report per-node status; failed nodes skip their dependents while independent branches can finish.
- Add a Preview Data node to inspect the actual intermediate rows at that pipeline step, including searchable and paginated output.
- Review run status, failures, metrics, and downloadable outputs in Execution History and Processed Data.
- Design data-backed dashboards with 16 chart types, category-aware percentage aggregation, configurable chart legends, KPI cards, tables, text, images, sections, and interactive filters. Chart field mappings are validated against the selected dataset schema; save dashboard JSON designs, reopen or duplicate them, preview responsive layouts, and export the complete dashboard as a high-resolution PNG.
- Dashboard counts and recent activity are derived from locally stored metadata.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Application and storage status |
| `GET` | `/api/dashboard/stats` | Real counts and recent file/workflow activity |
| `GET` | `/api/files` | List file metadata; optional `?status=uploaded` or `?status=processed` |
| `POST` | `/api/files/upload` | Multipart upload using the `file` field |
| `GET` | `/api/files/<file_id>/preview` | Search and page through dataset rows (`page`, `page_size`, `q`) |
| `GET` | `/api/files/<file_id>/schema` | Inspect dataset columns and inferred types |
| `GET` | `/api/files/<file_id>/summary` | Dataset quality and numeric statistics |
| `POST` | `/api/files/<file_id>/clean` | Apply a cleaning operation to a derived copy |
| `GET` | `/api/files/<file_id>/download` | Download an uploaded or processed dataset |
| `DELETE` | `/api/files/<file_id>` | Delete a stored dataset and its metadata |
| `GET` | `/api/workflows` | List saved workflow JSON |
| `POST` | `/api/workflows` | Create or update a workflow structure |
| `GET` | `/api/workflows/<workflow_id>` | Retrieve a saved workflow |
| `POST` | `/api/workflows/<workflow_id>/validate` | Validate a saved workflow and get execution order |
| `POST` | `/api/workflows/<workflow_id>/run` | Start a background workflow run (`202` with an execution ID) |
| `POST` | `/api/workflows/<workflow_id>/execute` | Execute a saved workflow synchronously for API compatibility |
| `DELETE` | `/api/workflows/<workflow_id>` | Delete a saved workflow |
| `GET` | `/api/executions` | List workflow runs; optional `status` and `q` filters |
| `GET` | `/api/executions/<execution_id>` | Retrieve one workflow run and its details |
| `GET` | `/api/executions/<execution_id>/previews/<node_id>` | Search and page through a Preview Data node's intermediate rows |

## Tests

Run the backend tests from the project root:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Tests use temporary storage directories and do not touch the application's local data.

## Project structure

```text
backend/
  app.py
  requirements.txt
  simple_etl/
    config.py
    routes/
    services/
    utils/
frontend/
  index.html
  css/style.css
  js/
tests/
storage/
  uploads/ processed/ workflows/ logs/ metadata/
```

The earlier FastAPI/React prototype remains in `backend/app/` and `frontend/src/` for reference. The active application runs through `backend/app.py` and serves the HTML/CSS/JavaScript in `frontend/`. The pre-existing `etlstudio.db` file is legacy data; the active application does not open or modify it.

## Not included

Authentication, collaboration, scheduling, and AI features are not implemented.