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
if (!(Test-Path .env)) { Copy-Item .env.example .env }
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
| `ACTIVE_STORAGE_BACKEND` | `filesystem` | Initial record backend: `filesystem` or `postgresql`; a saved Settings selection takes precedence |
| `STORAGE_ROOT` | `storage` | Root for uploaded data, workflows, metadata, and logs; relative paths resolve from the project root |
| `MAX_UPLOAD_SIZE_MB` | `100` | Per-file upload limit |
| `FRONTEND_ORIGINS` | Local app origins | Comma-separated CORS allowlist for `/api/*` |
| `HOST` | `127.0.0.1` | Flask bind address |
| `PORT` | `5000` | Flask port |
| `FLASK_DEBUG` | `false` | Enables Flask debug mode only when explicitly set to `true` |
| `CONNECTIONS_API_TOKEN` | Empty | Bearer token required for external connection management and preview endpoints; external connections remain disabled until set |

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

## Optional PostgreSQL Storage

File System is the default and works without a PostgreSQL server. PostgreSQL is optional; the application continues to store CSV, XLSX, and JSON dataset bytes under `STORAGE_ROOT/uploads/` and `STORAGE_ROOT/processed/`. PostgreSQL stores application records and references to those files.

Install PostgreSQL Server separately using the official Windows installer. Start the installed PostgreSQL service from Windows Services (or PowerShell with the service name shown by `Get-Service *postgres*`). The Python packages in `backend\requirements.txt` provide the client driver; they do not install a database server.

Open **Settings → Storage Configuration** to enter the host, port, application database, username, password, and maintenance database. Passwords are stored in the operating system credential vault via Python Keyring; they are not written to `.env`, JSON settings, or API responses. Test the connection, save the configuration, then initialize the database. The database user needs `CREATEDB` for automatic database creation. Otherwise, create the configured application database manually and initialize again.

Initialization creates schema and versioned migration tracking only. It never imports, copies, edits, or deletes File System workflows, dashboards, executions, or dataset metadata. An existing database without Simple ETL migration history is treated as unmanaged and initialization stops without changing it. Initialization is safe to repeat for a database managed by this application.

After initialization, choose **Activate PostgreSQL**. New records are then written to PostgreSQL; File System records remain where they are and are not merged into PostgreSQL. **Return to File System** switches new writes back without exporting or deleting PostgreSQL records. Switching backends does not migrate data in either direction.

The saved active backend and non-secret connection settings are kept in `STORAGE_ROOT/metadata/storage_backend.json` so the app can select the same backend after restart. If PostgreSQL is active but unavailable, application data requests return a storage error; the application does not silently fall back to File System.

## External Workflow Connections

External MySQL/PostgreSQL connections are data sources only. They are independent of the application's PostgreSQL storage configuration and never select, initialize, or modify the application database. Use database accounts with SELECT-only permissions.

Set a long random `CONNECTIONS_API_TOKEN` in the root `.env` file and restart Flask before using the Connection Manager. Generate a value with:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

The browser asks for this bearer token when opening the Connection Manager and keeps it in tab-scoped session storage. Connection metadata is saved in filesystem JSON or the app PostgreSQL `external_connections` table, depending on the active application storage backend. Passwords, API keys, tokens, basic-auth credentials, and custom header values are kept in the operating system credential vault via Keyring and are never included in workflow definitions or connection responses. If application PostgreSQL storage is already initialized, run **Initialize database** from Settings once to apply migration `0002_external_connections`.

Create or test connections in **Workflow Builder → Manage connections**, then choose the saved connection in a MySQL Input, PostgreSQL Input, or REST API Input node. Database nodes accept a table or one read-only SELECT query with named parameters. API nodes support GET, JSON/CSV responses, nested data paths, field mapping, and configurable page, offset, next-URL, or cursor pagination. Limits are 50 API pages, 2,000 records per page, 50,000 rows per extraction, 10 MB per API response, 25 MB per API extraction, and 50 MB per database extraction. Database query execution and API calls are bounded by the configured timeout. Node previews read actual records and are capped at 100 rows.

Private or local database hosts are rejected by default. To connect to a trusted internal database, explicitly enable **Trust private/local network** on that saved database connection. REST API destinations must resolve to public addresses; redirects and cross-origin pagination links are blocked. API URLs must not embed credentials or query strings; use the protected authentication fields instead. Custom database SQL is conservatively limited to a single SELECT statement, but database-level read-only privileges remain required.

## Features

- Upload CSV, XLSX, and JSON datasets, individually or in batches, with size and content validation.
- Inspect schema, column types, missing values, duplicates, and numeric statistics; search and paginate dataset previews.
- Preview cleaning operations live and chain them sequentially before creating a processed copy, including missing-value handling, duplicate removal, row filters, text normalization, type conversion, column changes, and IQR outlier handling. Preview rows are capped at 50 and source uploads remain unchanged.
- Build workflows with connected input, transformation, merge, preview, and export nodes. Branching is supported, while merge nodes require two connected inputs.
- Use saved MySQL, PostgreSQL, and REST API connections as workflow input nodes. External reads are bounded, read-only, and pass DataFrames through the existing transformation and output nodes.
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
| `POST` | `/api/files/<file_id>/clean/preview` | Temporarily preview a sequential cleaning operation list without saving a dataset |
| `POST` | `/api/files/<file_id>/clean` | Apply one operation or a cleaning sequence to a derived copy |
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
| `GET` | `/api/connections` | List saved external connections (Bearer token required) |
| `POST` | `/api/connections` | Create a saved connection (Bearer token required) |
| `PUT` | `/api/connections/<connection_id>` | Update a saved connection (Bearer token required) |
| `DELETE` | `/api/connections/<connection_id>` | Delete a saved connection and its protected credentials (Bearer token required) |
| `POST` | `/api/connections/test` | Test a saved or unsaved connection (Bearer token required) |
| `GET` | `/api/connections/<connection_id>/tables` | List database schemas and tables (Bearer token required) |
| `POST` | `/api/connections/<connection_id>/preview` | Read a bounded actual-data preview (Bearer token required) |

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

User accounts, collaboration, scheduling, and AI features are not implemented. External-connection routes use the configured shared bearer token; this is intended for a trusted local installation, not multi-user access control.