# Simple ETL Studio

Simple ETL Studio is a local workspace for inspecting, cleaning, transforming, and exporting datasets through visual ETL workflows. File System storage is the default. PostgreSQL can optionally store application records while uploaded and processed CSV, XLSX, and JSON files remain in managed file storage.

## Requirements

- Python 3.11 or newer
- Node.js and npm (for the Dashboard Designer's local visualization libraries)
- Windows PowerShell for the commands below

The Flask server serves both the API and the frontend. Install the frontend packages once so Flask can serve the local charting and PNG-export libraries.

## Install and run

From the project root:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
Set-Location frontend
npm ci
Set-Location ..
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
.\.venv\Scripts\python.exe backend\app.py
```

Open http://127.0.0.1:5000. The API health check is at http://127.0.0.1:5000/api/health.

To stop the development server, press `Ctrl+C` in its PowerShell terminal.

## Authentication and accounts

Authentication is enabled by default. New installations open at `/login`; select **Sign Up** to create a standard user account. Successful registration signs the user in. Accounts and sessions remain in File System storage when the application metadata backend is switched to PostgreSQL, so activating PostgreSQL does not log users out or require copying accounts. Sessions use HttpOnly cookies and CSRF protection, expire after 30 minutes of inactivity, and can persist for up to 30 days when **Remember me** is selected. Profile pictures are limited to PNG, JPEG, or WebP images up to 2 MB.

Set a stable secret key in `.env` before running a persistent deployment. For example, generate one in PowerShell with:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

Copy the output to `FLASK_SECRET_KEY` in `.env`. Leave `AUTH_COOKIE_SECURE=false` for local HTTP development; set it to `true` when the application is served over HTTPS. Do not commit `.env` or share its secret key.

Create the initial administrator from the project root; the CLI prompts for the account details and a strong password without echoing the password:

```powershell
python -m flask --app backend\app.py create-admin
```

Public registration always creates a standard user. Administrators can use the protected `/api/admin/users`, `/api/admin/activity`, and `/api/admin/sessions` APIs. Password recovery is not available because no secure email recovery mechanism is configured.

User-owned files, datasets, workflows, dashboards, and execution history are isolated by the authenticated account. Existing records are not automatically assigned to a new user and remain hidden until explicitly migrated. Account, session, activity, and profile-image data remain under `STORAGE_ROOT\auth`, independently of the selected application metadata backend. PostgreSQL authentication tables are initialized for schema compatibility, but initialization does not transfer or remove File System accounts.

Register and sign in using the existing account regardless of whether File System or PostgreSQL is selected for application metadata. If PostgreSQL is unavailable while it is active, PostgreSQL-backed application data requests fail rather than silently falling back to File System.

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
| `FLASK_SECRET_KEY` | generated per process | Stable secret used to sign CSRF tokens; configure a private value for deployments |
| `AUTH_COOKIE_SECURE` | `false` | Set to `true` when serving the application over HTTPS |
| `POSTGRES_HOST` | `localhost` | Initial PostgreSQL host (can also be set in Settings) |
| `POSTGRES_PORT` | `5432` | Initial PostgreSQL port |
| `POSTGRES_DB` | `simple_etl_studio_db` | Initial application database |
| `POSTGRES_USER` | `postgres` | Initial PostgreSQL username |
| `POSTGRES_PASSWORD` | unset | Optional password source; alternatively save it in the OS credential store from Settings |
| `POSTGRES_MAINTENANCE_DB` | `postgres` | Database used to inspect/create the application database |

`STORAGE_MODE` remains a local/server deployment label. The active metadata backend is selected in Settings and is File System on a fresh install. PostgreSQL configuration fields are saved locally; the password is kept in the operating system credential store (never in `.env`, JSON settings, browser responses, or application logs). If secure credential storage is unavailable, set `POSTGRES_PASSWORD` in the server environment instead. Do not put a real password in `.env.example`.

### Optional PostgreSQL storage

Install and start PostgreSQL Server separately; the Python dependency installs only the client driver. On Windows, find the installed service and start it from an elevated PowerShell if needed:

```powershell
Get-Service *postgres*
Start-Service -Name <service-name>
```

In **Settings → PostgreSQL**, enter the host, port, application database, user, password, and maintenance database. Use **Test Connection** to check authentication and database-creation permission. Save the configuration, then choose **Initialize Database**. Initialization creates the application database if permitted and adds the schema without importing any existing File System records or replacing existing PostgreSQL data. A user without `CREATEDB` can create the configured application database manually and initialize again. After initialization, choose **Activate PostgreSQL**.

The PostgreSQL schema stores metadata in `files`, `datasets`, `workflows`, `workflow_executions`, `execution_node_results`, and `dashboards`, with indexes, foreign-key relationships, and a `schema_migrations` version table. Dataset contents continue to use `STORAGE_ROOT\uploads` and `STORAGE_ROOT\processed`. Existing File System workflows, dashboards, execution history, and dataset metadata stay where they were; they are not automatically copied to PostgreSQL.

Switching between File System and PostgreSQL does not transfer records. Each backend retains its own records, and the app does not silently merge the two. If the selected PostgreSQL server becomes unavailable, storage requests fail rather than falling back to JSON files. Use the Settings page to correct the connection or return to File System.

For a server deployment, set `STORAGE_MODE=server` and point `STORAGE_ROOT` at a persistent directory outside the application code, for example:

```powershell
$env:STORAGE_MODE = "server"
$env:STORAGE_ROOT = "D:\SimpleETLData"
$env:FLASK_DEBUG = "false"
python backend\app.py
```

The configured storage root contains managed dataset files in both modes. In File System mode it also contains JSON metadata:

- `uploads/`: original uploaded files
- `processed/`: derived datasets from cleaning operations and workflow exports
- `workflows/`: one JSON file per saved workflow
- `dashboards/`: one JSON file per saved dashboard design
- `logs/`: rotating application log
- `metadata/`: JSON file and execution indexes

The local `metadata/storage_config.json` stores the selected backend and non-secret connection settings. PostgreSQL credentials are stored separately through the operating system credential manager.

Do not place `.env`, uploaded datasets, generated metadata, or logs under source control. The root `.gitignore` excludes these paths.

## Features

- Upload CSV, XLSX, and JSON datasets, individually or in batches, with size and content validation.
- Inspect schema, column types, missing values, duplicates, and numeric statistics; search and paginate dataset previews.
- Preview cleaning operations live and chain them sequentially before creating a processed copy, including missing-value handling, duplicate removal, row filters, text normalization, type conversion, column changes, and IQR outlier handling. Preview rows are capped at 50 and source uploads remain unchanged.
- Build workflows with connected input, transformation, merge, preview, and export nodes. Branching is supported, while merge nodes require two connected inputs.
- Validate and run workflows, including filters, column selection and renaming, aggregation, two-input joins, and CSV/XLSX/JSON exports. The Statistical Summary node calculates numerical and categorical statistics from its actual upstream data, previews both summary types, and passes its result to export nodes.
- Select and delete saved workflow definitions individually or in bulk. Existing execution history and generated datasets are retained; definitions with a running execution cannot be deleted.
- Add a Preview Data node to inspect the actual intermediate rows at that pipeline step, including searchable and paginated output.
- Review run status, failures, metrics, and downloadable outputs in Execution History and Processed Data.
- Design data-backed dashboards with 16 chart types, category-aware percentage aggregation, configurable chart legends, KPI cards, tables, text, images, sections, and interactive filters. Chart field mappings are validated against the selected dataset schema; save dashboard JSON designs, reopen or duplicate them, and refresh against the selected imported or processed dataset.
- Arrange dashboard items on a responsive 12-column canvas with compact chart defaults (KPI 3 columns × 125 px, charts 4–6 columns × 250–255 px, tables full-width × 320 px). Drag cards to reorder, resize from the selected card handle or its width/height controls, and use Auto Arrange to apply a grouped compact layout after confirming the change.
- Use Large Screen / Focus Mode in the Workflow Builder and Dashboard Designer to expand the shared canvas, add and arrange nodes or dashboard components, zoom, save, and return without recreating editor state. Dashboard components can be moved by their headers, resized by the selected card handle, aligned, layered, and placed with persisted 12-column X positions and pixel Y positions; older grid layouts receive a compact backward-compatible placement when opened.
- Choose from seven Canvas & Appearance presets and common desktop, widescreen, presentation, A4, or custom dimensions. Canvas colors, spacing, padding, radius, shadow, grid visibility, alignment, and dimensions are stored with dashboard configuration; legacy dashboards receive a default canvas without losing their components.
- Switch between Edit Mode and Presentation Mode, with optional browser fullscreen and Escape support. Export a saved dashboard as a 2× PNG after editor controls are hidden and charts, fonts, and images finish rendering.
- Delete saved dashboard definitions individually or in bulk without deleting referenced datasets. Deleting the currently open dashboard closes it and returns the designer to a blank dashboard.
- Set a global light, dark, or system theme and adjust canvas grid style, visibility, node density, snapping, and contrast. Appearance preferences are saved in browser local storage and are independent of whether File System or PostgreSQL metadata is active.
- Dashboard counts and recent activity are derived from the active metadata backend.
- Settings can test, initialize, and activate PostgreSQL without migrating existing File System records.

## API

Authentication endpoints include `GET /api/auth/status`, `GET /api/auth/me`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `PATCH /api/auth/profile`, `POST /api/auth/profile-picture`, and `POST /api/auth/password`. Administrator endpoints are `GET /api/admin/users`, `PATCH /api/admin/users/<user_id>`, `GET /api/admin/activity`, and `GET /api/admin/sessions`. State-changing requests require the CSRF cookie and matching `X-CSRF-Token` header.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Application and storage status |
| `GET` | `/api/storage/status` | Active backend, storage health, counts, and PostgreSQL schema status |
| `GET` | `/api/storage/config` | Non-secret storage connection settings |
| `POST` | `/api/storage/config` | Save PostgreSQL settings and an optional OS-keyring password |
| `POST` | `/api/storage/postgresql/test-connection` | Test PostgreSQL reachability, authentication, and database-creation permission |
| `POST` | `/api/storage/postgresql/initialize` | Create the application database if allowed and initialize schema |
| `GET` | `/api/storage/postgresql/schema-status` | Verify schema readiness and version |
| `GET` | `/api/storage/postgresql/migrations` | List applied schema migrations |
| `POST` | `/api/storage/postgresql/activate` | Activate an initialized PostgreSQL backend |
| `POST` | `/api/storage/filesystem/activate` | Return to File System storage |
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
| `GET` | `/api/workflows/references?workflow_id=<id>` | Count execution-history and processed-dataset references |
| `POST` | `/api/workflows/delete-selected` | Delete workflow definitions in bulk while retaining history and datasets |
| `POST` | `/api/workflows/<workflow_id>/validate` | Validate a saved workflow and get execution order |
| `POST` | `/api/workflows/<workflow_id>/run` | Start a background workflow run (`202` with an execution ID) |
| `POST` | `/api/workflows/<workflow_id>/execute` | Execute a saved workflow synchronously for API compatibility |
| `DELETE` | `/api/workflows/<workflow_id>` | Delete a saved workflow |
| `POST` | `/api/dashboards` | Create a saved dashboard definition |
| `GET` | `/api/dashboards` | List saved dashboard definitions |
| `GET` | `/api/dashboards/<dashboard_id>` | Retrieve a saved dashboard definition |
| `GET` | `/api/dashboards/<dashboard_id>/data` | Load a dashboard's selected dataset preview |
| `PUT` | `/api/dashboards/<dashboard_id>` | Update a saved dashboard definition |
| `DELETE` | `/api/dashboards/<dashboard_id>` | Delete one dashboard definition while retaining its datasets |
| `POST` | `/api/dashboards/delete-selected` | Delete dashboard definitions in bulk while retaining their datasets |
| `GET` | `/api/executions` | List workflow runs; optional `status` and `q` filters |
| `GET` | `/api/executions/<execution_id>` | Retrieve one workflow run and its details |
| `GET` | `/api/executions/<execution_id>/previews/<node_id>` | Search and page through Preview Data rows; Statistical Summary nodes also accept `?summary_type=numerical` or `?summary_type=categorical` |

## Tests

Run the backend tests from the project root:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Tests use temporary storage directories and do not touch the application's local data. PostgreSQL connection/initialization tests require an available PostgreSQL server; no real PostgreSQL integration test should be considered passed unless it has been run against one.

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