from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from .connection_security import ConnectionSecurityError, validate_api_url, validate_host
from .metadata_service import MetadataService
from .storage_manager import StorageUnavailableError

KEYRING_SERVICE = "simple-etl-studio-external-connections"
CONNECTION_KINDS = {"mysql", "postgresql", "api"}
_SAFE_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$")
_RESERVED_HEADERS = {"authorization", "proxy-authorization", "cookie", "host", "content-length", "connection", "transfer-encoding"}


class ConnectionConfigurationError(ValueError):
    pass


class ConnectionManager:
    def __init__(self, storage):
        self.metadata = MetadataService(storage)

    @staticmethod
    def _keyring():
        try:
            import keyring
        except ImportError as exc:
            raise StorageUnavailableError("Secure credential storage is unavailable. Install the project requirements and retry.") from exc
        return keyring

    @staticmethod
    def _port(value: Any, default: int) -> int:
        if isinstance(value, bool):
            raise ConnectionConfigurationError("Port must be between 1 and 65535.")
        try:
            port = int(value if value not in (None, "") else default)
        except (TypeError, ValueError) as exc:
            raise ConnectionConfigurationError("Port must be between 1 and 65535.") from exc
        if not 1 <= port <= 65535:
            raise ConnectionConfigurationError("Port must be between 1 and 65535.")
        return port

    @staticmethod
    def _timeout(value: Any) -> int:
        try:
            timeout = int(value if value not in (None, "") else 10)
        except (TypeError, ValueError) as exc:
            raise ConnectionConfigurationError("Timeout must be between 1 and 60 seconds.") from exc
        if isinstance(value, bool) or not 1 <= timeout <= 60:
            raise ConnectionConfigurationError("Timeout must be between 1 and 60 seconds.")
        return timeout

    @staticmethod
    def _text(payload: dict[str, Any], key: str, label: str, maximum: int = 255) -> str:
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
            raise ConnectionConfigurationError(f"Enter a {label} of {maximum} characters or fewer.")
        return value.strip()

    @classmethod
    def normalize(cls, payload: dict[str, Any], previous: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
        merged = {**(previous or {}), **payload}
        kind = merged.get("kind")
        if kind not in CONNECTION_KINDS:
            raise ConnectionConfigurationError("Choose MySQL, PostgreSQL, or REST API as the connection type.")
        if previous and previous.get("kind") != kind:
            raise ConnectionConfigurationError("Edit a saved connection without changing its type; create a separate connection for another source type.")
        name = cls._text(merged, "name", "connection name", 120)
        trusted = merged.get("allow_private_network", (previous or {}).get("allow_private_network", False))
        if not isinstance(trusted, bool):
            raise ConnectionConfigurationError("Trusted network setting must be true or false.")
        if kind == "api" and trusted:
            raise ConnectionConfigurationError("Private network access is available only for explicitly trusted database connections.")
        timeout = cls._timeout(merged.get("timeout", 10))
        metadata: dict[str, Any] = {
            "connection_id": (previous or {}).get("connection_id") or uuid4().hex,
            "kind": kind,
            "name": name,
            "allow_private_network": trusted,
            "timeout": timeout,
            "created_at": (previous or {}).get("created_at") or datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        secrets: dict[str, Any] = {}
        if kind in {"mysql", "postgresql"}:
            try:
                metadata.update({
                    "host": validate_host(cls._text(merged, "host", "host"), allow_private=trusted),
                    "port": cls._port(merged.get("port"), 3306 if kind == "mysql" else 5432),
                    "database": cls._text(merged, "database", "database name", 128),
                    "username": cls._text(merged, "username", "username", 128),
                    "schema": cls._text(merged, "schema", "schema", 128) if kind == "postgresql" and merged.get("schema") else ("public" if kind == "postgresql" else None),
                })
            except ConnectionSecurityError as exc:
                raise ConnectionConfigurationError(str(exc)) from exc
            password = payload.get("password")
            if password is not None and not isinstance(password, str):
                raise ConnectionConfigurationError("Password must be text.")
            if isinstance(password, str) and password:
                secrets["password"] = password
        else:
            try:
                metadata["api_url"] = validate_api_url(cls._text(merged, "api_url", "API URL", 2048), allow_private=False)
            except ConnectionSecurityError as exc:
                raise ConnectionConfigurationError(str(exc)) from exc
            method = merged.get("method", "GET")
            if method != "GET":
                raise ConnectionConfigurationError("Only GET is currently supported for read-only API extraction.")
            metadata["method"] = method
            auth_type = merged.get("auth_type", "none")
            if auth_type not in {"none", "api_key", "bearer", "basic"}:
                raise ConnectionConfigurationError("Choose a supported API authentication type.")
            metadata["auth_type"] = auth_type
            api_key_name = str(merged.get("api_key_name", "X-API-Key"))[:100]
            if not _SAFE_HEADER_NAME.fullmatch(api_key_name) or api_key_name.lower() in _RESERVED_HEADERS:
                raise ConnectionConfigurationError("API key header name is invalid or reserved.")
            metadata["api_key_name"] = api_key_name
            header_values = cls._headers(merged.get("headers", {}))
            metadata["headers"] = {key: "" for key in header_values}
            if any(header_values.values()):
                secrets["headers"] = {key: value for key, value in header_values.items() if value}
            metadata["query_params"] = cls._query_params(merged.get("query_params", {}))
            for key in ("api_key", "token", "basic_username", "basic_password"):
                secret = payload.get(key)
                if secret is not None and not isinstance(secret, str):
                    raise ConnectionConfigurationError("Authentication values must be text.")
                if isinstance(secret, str) and secret:
                    secrets[key] = secret
            if auth_type == "api_key" and not (secrets.get("api_key") or (previous and previous.get("auth_type") == auth_type)):
                raise ConnectionConfigurationError("Enter an API key before saving this connection.")
            if auth_type == "bearer" and not (secrets.get("token") or (previous and previous.get("auth_type") == auth_type)):
                raise ConnectionConfigurationError("Enter a bearer token before saving this connection.")
            if auth_type == "basic":
                has_saved_basic = bool(previous and previous.get("auth_type") == auth_type)
                if not (secrets.get("basic_username") or has_saved_basic) or not (secrets.get("basic_password") or has_saved_basic):
                    raise ConnectionConfigurationError("Enter a basic-auth username and password before saving this connection.")
        return metadata, secrets

    @classmethod
    def _headers(cls, value: Any) -> dict[str, str]:
        if not isinstance(value, dict) or len(value) > 30:
            raise ConnectionConfigurationError("Headers must be an object with at most 30 entries.")
        headers = {}
        for key, item in value.items():
            if not isinstance(key, str) or not _SAFE_HEADER_NAME.fullmatch(key) or key.lower() in _RESERVED_HEADERS:
                raise ConnectionConfigurationError("A header name is invalid or reserved for authentication.")
            if not isinstance(item, str) or len(item) > 2000:
                raise ConnectionConfigurationError("Header values must be text of at most 2000 characters.")
            headers[key] = item
        return headers

    @staticmethod
    def _query_params(value: Any) -> dict[str, str]:
        if not isinstance(value, dict) or len(value) > 50:
            raise ConnectionConfigurationError("Query parameters must be an object with at most 50 entries.")
        params = {}
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key) > 100 or not isinstance(item, (str, int, float, bool)):
                raise ConnectionConfigurationError("Query parameter names and values must be simple text or numbers.")
            if re.search(r"password|token|secret|api.?key|authorization", key, re.IGNORECASE):
                raise ConnectionConfigurationError("Authentication values must use a protected authentication field, not query parameters.")
            params[key] = str(item)[:2000]
        return params

    def list(self) -> list[dict[str, Any]]:
        return sorted(self.metadata.list_connections(), key=lambda item: (item.get("name", "").casefold(), item.get("connection_id", "")))

    def get(self, connection_id: str) -> dict[str, Any] | None:
        if not isinstance(connection_id, str) or len(connection_id) != 32:
            return None
        return self.metadata.get_connection(connection_id)

    def get_with_secrets(self, connection_id: str) -> tuple[dict[str, Any], dict[str, str]]:
        record = self.get(connection_id)
        if record is None:
            raise ConnectionConfigurationError("Saved connection was not found.")
        try:
            stored = self._keyring().get_password(KEYRING_SERVICE, connection_id)
        except StorageUnavailableError:
            raise
        except Exception as exc:
            raise StorageUnavailableError("Saved connection credentials could not be read from secure storage.") from exc
        try:
            secrets = json.loads(stored) if stored else {}
        except (TypeError, json.JSONDecodeError) as exc:
            raise StorageUnavailableError("Saved connection credentials are invalid.") from exc
        return record, secrets if isinstance(secrets, dict) else {}

    def save(self, payload: dict[str, Any], connection_id: str | None = None) -> dict[str, Any]:
        previous = self.get(connection_id) if connection_id else None
        if connection_id and previous is None:
            raise ConnectionConfigurationError("Saved connection was not found.")
        metadata, new_secrets = self.normalize(payload, previous)
        connection_id = metadata["connection_id"]
        if previous:
            _old_metadata, old_secrets = self.get_with_secrets(connection_id)
            preserved = {}
            if metadata["kind"] in {"mysql", "postgresql"}:
                if "password" not in new_secrets and previous.get("kind") == metadata["kind"]:
                    preserved["password"] = old_secrets.get("password")
            elif metadata["kind"] == "api":
                if isinstance(old_secrets.get("headers"), dict):
                    preserved["headers"] = {**old_secrets["headers"], **new_secrets.get("headers", {})}
                if previous.get("auth_type") == metadata.get("auth_type"):
                    for key in ("api_key", "token", "basic_username", "basic_password"):
                        if key not in new_secrets and key in old_secrets:
                            preserved[key] = old_secrets[key]
            new_secrets = {**preserved, **new_secrets}
        try:
            if new_secrets:
                self._keyring().set_password(KEYRING_SERVICE, connection_id, json.dumps(new_secrets, ensure_ascii=True))
            self.metadata.save_connection(metadata)
        except StorageUnavailableError:
            raise
        except Exception as exc:
            raise StorageUnavailableError("The connection could not be saved to secure storage.") from exc
        return metadata

    def delete(self, connection_id: str) -> bool:
        if not self.metadata.delete_connection(connection_id):
            return False
        try:
            keyring = self._keyring()
            try:
                keyring.delete_password(KEYRING_SERVICE, connection_id)
            except keyring.errors.PasswordDeleteError:
                pass
        except StorageUnavailableError:
            raise
        except Exception as exc:
            raise StorageUnavailableError("Connection metadata was removed, but its secure credential could not be deleted.") from exc
        return True