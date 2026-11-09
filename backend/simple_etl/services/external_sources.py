from __future__ import annotations

import io
import json
import re
import time
from typing import Any
from urllib.parse import urljoin, urlsplit

import pandas as pd
import requests
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL

from .connection_security import ConnectionSecurityError, validate_api_url, validate_select_query

MAX_EXTRACT_ROWS = 50_000
MAX_API_PAGES = 50
MAX_API_PAGE_SIZE = 2_000
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
MAX_EXTRACT_BYTES = 25 * 1024 * 1024
MAX_DATABASE_BYTES = 50 * 1024 * 1024


class ExternalSourceError(ValueError):
    pass


class ExternalSourceService:
    def _engine(self, connection: dict[str, Any], secrets: dict[str, str]):
        driver = "mysql+pymysql" if connection["kind"] == "mysql" else "postgresql+psycopg"
        url = URL.create(
            driver,
            username=connection["username"],
            password=secrets.get("password", ""),
            host=connection["host"],
            port=connection["port"],
            database=connection["database"],
        )
        return create_engine(url, connect_args={"connect_timeout": connection["timeout"]}, pool_pre_ping=True)

    @staticmethod
    def _begin_read_only(connection, kind: str, timeout: int) -> None:
        if kind == "mysql":
            connection.exec_driver_sql("START TRANSACTION READ ONLY")
            connection.exec_driver_sql(f"SET SESSION max_execution_time = {int(timeout * 1000)}")
        else:
            connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            connection.exec_driver_sql(f"SET LOCAL statement_timeout = '{int(timeout * 1000)}ms'")

    def test_database(self, connection: dict[str, Any], secrets: dict[str, str]) -> dict[str, Any]:
        engine = self._engine(connection, secrets)
        try:
            with engine.connect() as database:
                self._begin_read_only(database, connection["kind"], connection["timeout"])
                database.execute(text("SELECT 1")).scalar_one()
            return {"success": True, "message": "Database connection successful."}
        except Exception as exc:
            raise ExternalSourceError("Unable to connect to the external database. Check its address and read-only account credentials.") from exc
        finally:
            engine.dispose()

    def database_tables(self, connection: dict[str, Any], secrets: dict[str, str], schema: str | None = None) -> dict[str, Any]:
        engine = self._engine(connection, secrets)
        try:
            from sqlalchemy import inspect

            inspector = inspect(engine)
            if connection["kind"] == "postgresql":
                schemas = [
                    schema for schema in inspector.get_schema_names()
                    if schema not in {"information_schema", "pg_catalog"} and not schema.startswith("pg_toast")
                ]
                selected_schema = schema or connection.get("schema", "public")
                if selected_schema not in schemas:
                    raise ExternalSourceError("The selected PostgreSQL schema is not available.")
            else:
                schemas = [connection["database"]]
                selected_schema = connection["database"]
            tables = inspector.get_table_names(schema=selected_schema)
            return {"schemas": schemas, "tables": tables, "schema": selected_schema}
        except Exception as exc:
            raise ExternalSourceError("Database schemas and tables could not be retrieved.") from exc
        finally:
            engine.dispose()

    @staticmethod
    def _query_parameters(value: Any) -> dict[str, Any]:
        if value is None:
            return {}
        if not isinstance(value, dict) or len(value) > 100:
            raise ExternalSourceError("Query parameters must be an object with at most 100 entries.")
        if any(
            not isinstance(key, str)
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
            or re.search(r"password|token|secret|api.?key|authorization", key, re.IGNORECASE)
            for key in value
        ):
            raise ExternalSourceError("Query parameter names must be simple identifiers.")
        return value

    def extract_database(
        self,
        connection: dict[str, Any],
        secrets: dict[str, str],
        config: dict[str, Any],
        row_limit: int = MAX_EXTRACT_ROWS,
        allow_truncate: bool = False,
    ) -> tuple[pd.DataFrame, dict[str, Any]]:
        if not 1 <= row_limit <= MAX_EXTRACT_ROWS:
            raise ExternalSourceError("Requested row limit is outside the supported range.")
        query = config.get("query", "")
        parameters = self._query_parameters(config.get("query_parameters"))
        engine = self._engine(connection, secrets)
        try:
            if isinstance(query, str) and query.strip():
                statement = text(validate_select_query(query))
                required = set(re.findall(r"(?<!:):([A-Za-z_][A-Za-z0-9_]*)", query))
                if required != set(parameters):
                    raise ExternalSourceError("Provide one value for each named query parameter and no extras.")
            else:
                table = config.get("table")
                schema = config.get("schema") or connection.get("schema")
                if not isinstance(table, str) or not table or len(table) > 128:
                    raise ExternalSourceError("Choose a database table or enter a SELECT query.")
                quote = engine.dialect.identifier_preparer.quote
                if connection["kind"] == "postgresql":
                    if not isinstance(schema, str) or not schema or len(schema) > 128:
                        raise ExternalSourceError("Choose a valid PostgreSQL schema.")
                    table_sql = f"{quote(schema)}.{quote(table)}"
                else:
                    table_sql = quote(table)
                statement = text(f"SELECT * FROM {table_sql}")
                parameters = {}
            with engine.connect() as database:
                self._begin_read_only(database, connection["kind"], connection["timeout"])
                result = database.execution_options(stream_results=True).execute(statement, parameters)
                columns = list(result.keys())
                rows = result.fetchmany(row_limit + 1)
                has_more = len(rows) > row_limit
                if has_more:
                    if not allow_truncate:
                        raise ExternalSourceError(f"Extraction exceeds the {row_limit:,}-row limit. Narrow the query and retry.")
                    rows = rows[:row_limit]
            frame = pd.DataFrame.from_records([tuple(row) for row in rows], columns=columns)
            if int(frame.memory_usage(index=True, deep=True).sum()) > MAX_DATABASE_BYTES:
                raise ExternalSourceError("Database extraction exceeded the 50 MB limit. Narrow the query and retry.")
            return frame, {"row_count": len(frame), "column_count": len(frame.columns), "has_more": has_more}
        except (ExternalSourceError, ConnectionSecurityError):
            raise
        except Exception as exc:
            raise ExternalSourceError("The external database query failed. Check the selected schema, table, and query.") from exc
        finally:
            engine.dispose()

    @staticmethod
    def _path(value: Any, path: str) -> Any:
        current = value
        for token in re.findall(r"\[(\d+)\]|([^.[\]]+)", path):
            key = token[0] or token[1]
            if isinstance(current, list):
                current = current[int(key)]
            elif isinstance(current, dict):
                current = current[key]
            else:
                raise KeyError(path)
        return current

    @staticmethod
    def _response_body(response: requests.Response) -> bytes:
        chunks = []
        size = 0
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise ExternalSourceError("An API response exceeded the 10 MB per-request limit.")
            chunks.append(chunk)
        return b"".join(chunks)

    @staticmethod
    def _api_headers(connection: dict[str, Any], secrets: dict[str, str]) -> dict[str, str]:
        headers = {
            **{key: value for key, value in connection.get("headers", {}).items() if value},
            **secrets.get("headers", {}),
        }
        auth_type = connection.get("auth_type", "none")
        if auth_type == "api_key":
            name = connection.get("api_key_name", "X-API-Key")
            key = secrets.get("api_key")
            if not key:
                raise ExternalSourceError("The saved API key is unavailable.")
            headers[name] = key
        elif auth_type == "bearer":
            token = secrets.get("token")
            if not token:
                raise ExternalSourceError("The saved bearer token is unavailable.")
            headers["Authorization"] = f"Bearer {token}"
        elif auth_type == "basic":
            username, password = secrets.get("basic_username"), secrets.get("basic_password")
            if username is None or password is None:
                raise ExternalSourceError("Saved basic-auth credentials are unavailable.")
            import base64

            encoded = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {encoded}"
        headers.setdefault("Accept", "application/json, text/csv;q=0.9")
        return headers

    @staticmethod
    def _same_origin(first: str, second: str) -> bool:
        left, right = urlsplit(first), urlsplit(second)
        return (left.scheme, left.hostname, left.port) == (right.scheme, right.hostname, right.port)

    def _request_api(
        self,
        session: requests.Session,
        url: str,
        params: dict[str, Any],
        headers: dict[str, str],
        timeout: int,
        allow_private: bool,
    ) -> tuple[bytes, str, int]:
        try:
            validate_api_url(url, allow_private=allow_private, allow_query=True)
            response = session.get(url, params=params, headers=headers, timeout=(min(timeout, 10), timeout), allow_redirects=False, stream=True)
            if 300 <= response.status_code < 400:
                response.close()
                raise ExternalSourceError("API redirects are disabled for security. Use the final API URL.")
            if not response.ok:
                status_code = response.status_code
                response.close()
                raise ExternalSourceError(f"The API returned HTTP {status_code}.")
            body = self._response_body(response)
            return body, response.headers.get("Content-Type", "").lower(), response.status_code
        except ExternalSourceError:
            raise
        except requests.Timeout as exc:
            raise ExternalSourceError("The API request timed out.") from exc
        except requests.RequestException as exc:
            raise ExternalSourceError("Unable to reach the configured API.") from exc
        except ConnectionSecurityError as exc:
            raise ExternalSourceError(str(exc)) from exc
        finally:
            if "response" in locals():
                response.close()

    def extract_api(
        self,
        connection: dict[str, Any],
        secrets: dict[str, str],
        config: dict[str, Any],
        row_limit: int = MAX_EXTRACT_ROWS,
        allow_truncate: bool = False,
    ) -> tuple[pd.DataFrame, dict[str, Any]]:
        if not 1 <= row_limit <= MAX_EXTRACT_ROWS:
            raise ExternalSourceError("Requested row limit is outside the supported range.")
        try:
            data_path = config.get("data_path", "")
            if not isinstance(data_path, str) or len(data_path) > 500:
                raise ExternalSourceError("API data path must be text of at most 500 characters.")
            mapping = config.get("field_mapping", {})
            if not isinstance(mapping, dict) or len(mapping) > 500 or any(not isinstance(key, str) or not isinstance(value, str) or not value.strip() for key, value in mapping.items()):
                raise ExternalSourceError("Field mapping must map source names to non-empty column names.")
            pagination = config.get("pagination", {})
            if not isinstance(pagination, dict):
                raise ExternalSourceError("Pagination configuration must be an object.")
            mode = pagination.get("mode", "none")
            if mode not in {"none", "page", "offset", "next_url", "cursor"}:
                raise ExternalSourceError("Choose a supported API pagination mode.")
            page_size = int(pagination.get("page_size", 500))
            max_pages = int(pagination.get("max_pages", MAX_API_PAGES))
            if not 1 <= page_size <= MAX_API_PAGE_SIZE or not 1 <= max_pages <= MAX_API_PAGES:
                raise ExternalSourceError("Page size must be at most 2000 and page limit at most 50.")
            for key in ("page_param", "size_param", "offset_param", "limit_param", "cursor_param"):
                if key in pagination and (
                    not isinstance(pagination[key], str)
                    or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,99}", pagination[key])
                ):
                    raise ExternalSourceError("Pagination parameter names must be simple identifiers.")
            timeout = int(connection.get("timeout", 10))
            params = {**connection.get("query_params", {}), **self._query_parameters(config.get("query_params"))}
            headers = self._api_headers(connection, secrets)
            session = requests.Session()
            session.trust_env = False
            url = connection["api_url"]
            initial_url = url
            records: list[Any] = []
            total_bytes = 0
            pages = 0
            status_code = None
            started = time.perf_counter()
            next_cursor = None
            response_format = config.get("response_format", "auto")
            if response_format not in {"auto", "json", "csv"}:
                raise ExternalSourceError("Choose JSON, CSV, or automatic API response detection.")
            truncated = False
            while pages < (1 if mode == "none" else max_pages):
                request_params = dict(params)
                if mode == "page":
                    request_params[pagination.get("page_param", "page")] = int(pagination.get("start_page", 1)) + pages
                    request_params[pagination.get("size_param", "page_size")] = page_size
                elif mode == "offset":
                    request_params[pagination.get("offset_param", "offset")] = pages * page_size
                    request_params[pagination.get("limit_param", "limit")] = page_size
                elif mode == "cursor" and next_cursor is not None:
                    request_params[pagination.get("cursor_param", "cursor")] = next_cursor
                elif mode == "cursor" and pages == 0:
                    request_params[pagination.get("cursor_param", "cursor")] = pagination.get("initial_cursor", "")
                body, content_type, status_code = self._request_api(
                    session, url, request_params, headers, timeout, bool(connection.get("allow_private_network")),
                )
                total_bytes += len(body)
                if total_bytes > MAX_EXTRACT_BYTES:
                    raise ExternalSourceError("API extraction exceeded the 25 MB total response limit.")
                pages += 1
                count_before_page = len(records)
                is_csv = response_format == "csv" or (response_format == "auto" and "csv" in content_type)
                if is_csv:
                    batch = pd.read_csv(io.BytesIO(body), nrows=row_limit + 1 - len(records)).to_dict(orient="records")
                    records.extend(batch)
                else:
                    try:
                        payload = json.loads(body.decode("utf-8-sig"))
                        selected = self._path(payload, data_path) if data_path else payload
                    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
                        raise ExternalSourceError("The API response is not valid JSON at the configured data path.") from exc
                    if isinstance(selected, dict):
                        selected = [selected]
                    if not isinstance(selected, list):
                        raise ExternalSourceError("The selected API response path must contain an array or object.")
                    records.extend(selected)
                if len(records) > row_limit:
                    if not allow_truncate:
                        raise ExternalSourceError(f"API extraction exceeds the {row_limit:,}-row limit.")
                    records = records[:row_limit]
                    truncated = True
                    break
                batch_count = len(records) - count_before_page
                if mode == "none" or (mode in {"page", "offset"} and batch_count < page_size):
                    break
                if mode == "next_url":
                    try:
                        next_value = self._path(payload, pagination.get("next_url_path", "next"))
                    except (NameError, KeyError, IndexError, TypeError):
                        next_value = None
                    if not next_value:
                        break
                    candidate = urljoin(url, str(next_value))
                    validate_api_url(candidate, allow_private=False, allow_query=True)
                    if not self._same_origin(initial_url, candidate):
                        raise ExternalSourceError("Pagination links must remain on the configured API origin.")
                    url = candidate
                    params = {}
                elif mode == "cursor":
                    try:
                        next_cursor = self._path(payload, pagination.get("cursor_path", "next_cursor"))
                    except (NameError, KeyError, IndexError, TypeError):
                        next_cursor = None
                    if next_cursor in (None, "", False):
                        break
            session.close()
            if records and all(isinstance(item, dict) for item in records):
                records = [{mapping.get(key, key): value for key, value in row.items()} for row in records]
            frame = pd.DataFrame.from_records(records)
            metrics = {
                "status": "success",
                "http_status": status_code,
                "row_count": int(len(frame)),
                "column_count": int(len(frame.columns)),
                "pages_fetched": pages,
                "duration_seconds": round(time.perf_counter() - started, 4),
                "has_more": truncated,
            }
            return frame, metrics
        except ExternalSourceError:
            raise
        except (ValueError, TypeError, requests.RequestException) as exc:
            raise ExternalSourceError("The API extraction settings are invalid or the response could not be processed.") from exc

    def test_api(self, connection: dict[str, Any], secrets: dict[str, str]) -> dict[str, Any]:
        session = requests.Session()
        session.trust_env = False
        try:
            body, _content_type, status_code = self._request_api(
                session, connection["api_url"], connection.get("query_params", {}),
                self._api_headers(connection, secrets), int(connection["timeout"]),
                bool(connection.get("allow_private_network")),
            )
            return {"success": True, "http_status": status_code, "response_bytes": len(body)}
        finally:
            session.close()

    def test(self, connection: dict[str, Any], secrets: dict[str, str]) -> dict[str, Any]:
        if connection["kind"] == "api":
            return self.test_api(connection, secrets)
        return self.test_database(connection, secrets)

    def tables(self, connection: dict[str, Any], secrets: dict[str, str], schema: str | None = None) -> dict[str, Any]:
        if connection["kind"] == "api":
            raise ExternalSourceError("REST API connections do not have database tables.")
        return self.database_tables(connection, secrets, schema)

    def extract(
        self,
        connection: dict[str, Any],
        secrets: dict[str, str],
        config: dict[str, Any],
        row_limit: int = MAX_EXTRACT_ROWS,
        allow_truncate: bool = False,
    ) -> tuple[pd.DataFrame, dict[str, Any]]:
        if connection["kind"] == "api":
            return self.extract_api(connection, secrets, config, row_limit, allow_truncate)
        return self.extract_database(connection, secrets, config, row_limit, allow_truncate)