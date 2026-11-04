# Simple ETL Studio

Simple ETL Studio Phase 1 is a local, file-backed workspace for uploading datasets and designing visual ETL workflows. The application uses Flask, JSON metadata, and the local filesystem. It does not use a database.

## Requirements

- Python 3.11 or newer
- Windows PowerShell for the commands below

The Flask server serves both the API and the frontend. Node.js is not required to run the application.

## Install and run

From the project root:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
Copy-Item .env.example .env
python backend\app.py
```

Open http://127.0.0.1:5000. The API health check is at http://127.0.0.1:5000/api/health.

To stop the development server, press `Ctrl+C` in its PowerShell terminal.

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
- `processed/`: reserved for later processing phases
- `workflows/`: one JSON file per saved workflow
- `logs/`: rotating application log
- `metadata/`: JSON file and execution indexes

Do not place `.env`, uploaded datasets, generated metadata, or logs under source control. The root `.gitignore` excludes these paths.

## Phase 1 features

- Dashboard counts and recent activity derived from stored file and workflow metadata.
- CSV, XLSX, and JSON upload with size and content checks, safe generated filenames, file listing, filtering, and deletion.
- Visual workflow canvas with draggable nodes, configurable saved fields, directional connections, node removal, zoom, pan, fit, and a minimap.
- Workflows are validated and saved/reopened as JSON.
- Processed data and execution history show explicit empty states; workflow execution and transformations are not simulated in this phase.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Application and storage status |
| `GET` | `/api/dashboard/stats` | Real counts and recent file/workflow activity |
| `GET` | `/api/files` | List uploaded file metadata; optional `?status=uploaded` |
| `POST` | `/api/files/upload` | Multipart upload using the `file` field |
| `DELETE` | `/api/files/<file_id>` | Delete one stored upload and its metadata |
| `GET` | `/api/workflows` | List saved workflow JSON |
| `POST` | `/api/workflows` | Create or update a workflow structure |
| `GET` | `/api/workflows/<workflow_id>` | Retrieve a saved workflow |
| `DELETE` | `/api/workflows/<workflow_id>` | Delete a saved workflow |

## Tests

Run the backend tests from the project root:

```powershell
python -m pytest -q
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

The earlier FastAPI/React prototype remains in `backend/app/` and `frontend/src/` for reference. Phase 1 runs through `backend/app.py` and the static HTML/CSS/JavaScript served by Flask. The pre-existing `etlstudio.db` file is legacy data; this Phase 1 application does not open or modify it.

## Not included in Phase 1

Workflow execution, actual transformation and export operations, authentication, collaboration, scheduling, and AI features are not implemented. Node settings are saved as design metadata only.