<<<<<<< HEAD
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from shutil import disk_usage

from .postgres_schema import IncompatibleSchemaError, initialize_schema, schema_status
from .storage_service import FileSystemStorage

KEYRING_SERVICE = "simple-etl-studio-postgresql"
DEFAULT_POSTGRES_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "database": "simple_etl_db",
    "username": "postgres",
    "maintenance_database": "postgres",
}
VALID_BACKENDS = {"filesystem", "postgresql"}


class StorageUnavailableError(RuntimeError):
    pass


class StorageConfigurationError(ValueError):
    pass


class StorageManager:
    def __init__(self, filesystem: FileSystemStorage, initial_backend: str = "filesystem"):
        self.filesystem = filesystem
        self.state_path = filesystem.metadata_dir / "storage_backend.json"
        saved = filesystem.read_json(self.state_path, {})
        if not isinstance(saved, dict):
            saved = {}
        backend = saved.get("active_backend", initial_backend)
        self.active_backend = backend if backend in VALID_BACKENDS else "filesystem"
        postgres = saved.get("postgresql", {})
        persisted = postgres if isinstance(postgres, dict) else {}
        allowed_config = {key: persisted.get(key, value) for key, value in DEFAULT_POSTGRES_CONFIG.items()}
        try:
            self.postgresql_config = self.normalize_config(allowed_config)
        except StorageConfigurationError:
            self.postgresql_config = dict(DEFAULT_POSTGRES_CONFIG)
        self.last_connection = saved.get("last_successful_connection")
        self.last_initialization = saved.get("last_initialization_result")

    def _write_state(self) -> None:
        self.filesystem.write_json(self.state_path, {
            "active_backend": self.active_backend,
            "postgresql": self.postgresql_config,
            "last_successful_connection": self.last_connection,
            "last_initialization_result": self.last_initialization,
        })

    @staticmethod
    def normalize_config(payload: dict[str, Any]) -> dict[str, Any]:
        host = payload.get("host", DEFAULT_POSTGRES_CONFIG["host"])
        database = payload.get("database", payload.get("database_name", DEFAULT_POSTGRES_CONFIG["database"]))
        username = payload.get("username", DEFAULT_POSTGRES_CONFIG["username"])
        maintenance = payload.get("maintenance_database", DEFAULT_POSTGRES_CONFIG["maintenance_database"])
        port = payload.get("port", DEFAULT_POSTGRES_CONFIG["port"])
        if not all(isinstance(value, str) and value.strip() for value in (host, database, username, maintenance)):
            raise StorageConfigurationError("Host, database name, username, and maintenance database are required.")
        if isinstance(port, bool):
            raise StorageConfigurationError("PostgreSQL port must be between 1 and 65535.")
        try:
            normalized_port = int(port)
        except (TypeError, ValueError) as exc:
            raise StorageConfigurationError("PostgreSQL port must be between 1 and 65535.") from exc
        if not 1 <= normalized_port <= 65535:
            raise StorageConfigurationError("PostgreSQL port must be between 1 and 65535.")
        if len(database) > 63 or len(maintenance) > 63:
            raise StorageConfigurationError("PostgreSQL database names must be 63 characters or fewer.")
        return {
            "host": host.strip(),
            "port": normalized_port,
            "database": database.strip(),
            "username": username.strip(),
            "maintenance_database": maintenance.strip(),
        }

    def _keyring(self):
        try:
            import keyring
        except ImportError as exc:
            raise StorageUnavailableError("Secure credential storage is unavailable. Install the project requirements and retry.") from exc
        return keyring

    @staticmethod
    def _credential_user(config: dict[str, Any]) -> str:
        return f"{config['username']}@{config['host']}:{config['port']}/{config['database']}"

    def password_is_saved(self, config: dict[str, Any] | None = None) -> bool:
        try:
            value = self._keyring().get_password(KEYRING_SERVICE, self._credential_user(config or self.postgresql_config))
            return bool(value)
        except Exception:
            return False

    def save_postgresql_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        config = self.normalize_config(payload)
        previous_config = self.postgresql_config
        previous_user = self._credential_user(previous_config)
        current_user = self._credential_user(config)
        password = payload.get("password")
        if password is not None and not isinstance(password, str):
            raise StorageConfigurationError("PostgreSQL password must be text.")
        clear_password = payload.get("clear_password") is True
        if self.active_backend == "postgresql":
            if clear_password:
                raise StorageConfigurationError("Switch to File System before removing active PostgreSQL credentials.")
            active_password = password if isinstance(password, str) and password else self._password(config)
            if active_password is None:
                raise StorageConfigurationError("Enter the PostgreSQL password to update the active connection settings.")
            self.test_postgresql_connection({**config, "password": active_password})
        try:
            keyring = self._keyring()
            if isinstance(password, str) and password:
                keyring.set_password(KEYRING_SERVICE, self._credential_user(config), password)
            elif clear_password:
                try:
                    keyring.delete_password(KEYRING_SERVICE, current_user)
                except keyring.errors.PasswordDeleteError:
                    pass
            if previous_user != current_user:
                try:
                    keyring.delete_password(KEYRING_SERVICE, previous_user)
                except keyring.errors.PasswordDeleteError:
                    pass
        except StorageUnavailableError:
            raise
        except Exception as exc:
            raise StorageUnavailableError("The PostgreSQL password could not be saved to secure credential storage.") from exc
        self.postgresql_config = config
        self._write_state()
        return self.configuration_response()

    def configuration_response(self) -> dict[str, Any]:
        return {
            **self.postgresql_config,
            "password_configured": self.password_is_saved(),
            "active_backend": self.active_backend,
        }

    def _password(self, config: dict[str, Any], supplied: str | None = None) -> str | None:
        if supplied is not None:
            return supplied
        try:
            return self._keyring().get_password(KEYRING_SERVICE, self._credential_user(config))
        except StorageUnavailableError:
            raise
        except Exception as exc:
            raise StorageUnavailableError("Secure PostgreSQL credentials could not be read.") from exc

    @staticmethod
    def _connection(config: dict[str, Any], database: str, password: str | None, *, autocommit: bool = False):
        try:
            return psycopg.connect(
                host=config["host"],
                port=config["port"],
                dbname=database,
                user=config["username"],
                password=password,
                connect_timeout=4,
                application_name="simple-etl-studio",
                autocommit=autocommit,
            )
        except psycopg.Error as exc:
            raise StorageUnavailableError(StorageManager._safe_connection_error(exc)) from None

    @staticmethod
    def _safe_connection_error(error: psycopg.Error) -> str:
        code = getattr(error, "sqlstate", None)
        if code in {"28P01", "28000"}:
            return "Invalid database username or password."
        if code == "42501":
            return "The configured PostgreSQL user does not have the required permissions."
        return "Unable to connect to PostgreSQL. Check the host, port, database, and server status."

    def test_postgresql_connection(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        config = self.normalize_config(payload or self.postgresql_config)
        supplied = payload.get("password") if payload else None
        password = self._password(config, supplied)
        if password is None:
            raise StorageConfigurationError("Enter a PostgreSQL password or save one in secure credential storage.")
        try:
            with self._connection(config, config["maintenance_database"], password) as connection:
                can_create = connection.execute(
                    "SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user"
                ).fetchone()
                database_exists = connection.execute(
                    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)",
                    (config["database"],),
                ).fetchone()[0]
        except StorageUnavailableError:
            raise
        except psycopg.Error as exc:
            raise StorageUnavailableError(self._safe_connection_error(exc)) from None
        self.last_connection = datetime.now(timezone.utc).isoformat()
        self._write_state()
        return {
            "success": True,
            "message": "PostgreSQL connection successful.",
            "database_exists": bool(database_exists),
            "can_create_database": bool(can_create and can_create[0]),
            "last_successful_connection": self.last_connection,
        }

    def initialize_postgresql(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        config = self.normalize_config(payload or self.postgresql_config)
        supplied = payload.get("password") if payload else None
        password = self._password(config, supplied)
        if password is None:
            raise StorageConfigurationError("Enter a PostgreSQL password or save one in secure credential storage.")
        self.test_postgresql_connection({**config, "password": password})
        database_exists = False
        try:
            with self._connection(config, config["maintenance_database"], password, autocommit=True) as maintenance:
                database_exists = bool(maintenance.execute(
                    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)",
                    (config["database"],),
                ).fetchone()[0])
                if not database_exists:
                    can_create = maintenance.execute(
                        "SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user"
                    ).fetchone()
                    if not can_create or not can_create[0]:
                        raise StorageConfigurationError(
                            "The configured PostgreSQL user cannot create databases. Create the application database manually, then initialize again."
                        )
                    maintenance.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(config["database"])))
            with self._connection(config, config["database"], password) as application_database:
                result = initialize_schema(application_database)
        except (StorageConfigurationError, IncompatibleSchemaError):
            raise
        except StorageUnavailableError:
            raise
        except psycopg.Error as exc:
            raise StorageUnavailableError(self._safe_connection_error(exc)) from None
        self.postgresql_config = config
        self.last_initialization = {
            "success": True,
            "database_created": not database_exists,
            "schema_version": result["schema_version"],
            "initialized_at": datetime.now(timezone.utc).isoformat(),
        }
        self.save_postgresql_config({**config, "password": password})
        return {"success": True, "message": "Database initialized successfully. PostgreSQL is ready.", **self.last_initialization, "tables": result["tables"]}

    def get_postgresql_schema_status(self) -> dict[str, Any]:
        config = self.normalize_config(self.postgresql_config)
        try:
            password = self._password(config)
        except StorageUnavailableError as exc:
            return {"initialized": False, "schema_version": None, "error": str(exc)}
        if password is None:
            return {"initialized": False, "schema_version": None, "error": "PostgreSQL credentials are not configured."}
        try:
            with self._connection(config, config["database"], password) as connection:
                return schema_status(connection)
        except StorageUnavailableError as exc:
            return {"initialized": False, "schema_version": None, "error": str(exc)}

    def activate_postgresql(self) -> dict[str, Any]:
        config = self.normalize_config(self.postgresql_config)
        password = self._password(config)
        if password is None:
            raise StorageConfigurationError("Save PostgreSQL connection credentials before activating PostgreSQL.")
        previous_backend = self.active_backend
        previous_config = self.postgresql_config
        try:
            with self._connection(config, config["database"], password) as connection:
                schema = schema_status(connection)
                if not schema.get("initialized"):
                    raise StorageConfigurationError("Initialize the PostgreSQL database schema before activating PostgreSQL.")
                connection.execute(
                    """
                    INSERT INTO storage_settings(setting_key, value, updated_at)
                    VALUES (%s, %s, NOW())
                    ON CONFLICT (setting_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
                    """,
                    ("active_backend", Jsonb({"backend": "postgresql"})),
                )
            self.active_backend = "postgresql"
            self.postgresql_config = config
            self._write_state()
        except (StorageConfigurationError, StorageUnavailableError):
            self.active_backend = previous_backend
            self.postgresql_config = previous_config
            raise
        except psycopg.Error as exc:
            self.active_backend = previous_backend
            self.postgresql_config = previous_config
            raise StorageUnavailableError(self._safe_connection_error(exc)) from None
        except OSError as exc:
            self.active_backend = previous_backend
            self.postgresql_config = previous_config
            try:
                self._write_state()
            except OSError:
                pass
            raise StorageUnavailableError("PostgreSQL was verified, but the selected storage mode could not be saved.") from exc
        return {"active_backend": self.active_backend, "message": "PostgreSQL is now the active storage backend."}

    def activate_filesystem(self) -> dict[str, Any]:
        if not all(path.is_dir() for path in (self.filesystem.uploads_dir, self.filesystem.processed_dir, self.filesystem.metadata_dir)):
            raise StorageUnavailableError("File System storage is unavailable.")
        previous_backend = self.active_backend
        self.active_backend = "filesystem"
        try:
            self._write_state()
        except OSError as exc:
            self.active_backend = previous_backend
            raise StorageUnavailableError("File System is available, but the selected storage mode could not be saved.") from exc
        return {"active_backend": self.active_backend, "message": "File System is now the active storage backend."}

    def get_metadata_backend(self):
        if self.active_backend == "filesystem":
            from .metadata_service import FileSystemMetadataBackend

            return FileSystemMetadataBackend(self.filesystem)
        from .postgres_metadata import PostgresMetadataBackend

        return PostgresMetadataBackend(self)

    def status(self) -> dict[str, Any]:
        postgres_status = {
            **self.postgresql_config,
            "password_configured": self.password_is_saved(),
        }
        if not postgres_status["password_configured"]:
            postgres_status.update({"database_exists": None, "can_create_database": None})
        else:
            try:
                password = self._password(self.postgresql_config)
                with self._connection(self.postgresql_config, self.postgresql_config["maintenance_database"], password) as connection:
                    result = connection.execute(
                        """
                        SELECT
                            EXISTS (SELECT 1 FROM pg_database WHERE datname = %s),
                            COALESCE((SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user), FALSE)
                        """,
                        (self.postgresql_config["database"],),
                    ).fetchone()
                postgres_status.update({"database_exists": bool(result[0]), "can_create_database": bool(result[1])})
            except StorageUnavailableError as exc:
                postgres_status.update({"database_exists": None, "can_create_database": None, "connection_error": str(exc)})
            except psycopg.Error as exc:
                postgres_status.update({"database_exists": None, "can_create_database": None, "connection_error": self._safe_connection_error(exc)})
        schema = self.get_postgresql_schema_status()
        return {
            "active_backend": self.active_backend,
            "filesystem_available": all(path.is_dir() for path in (self.filesystem.uploads_dir, self.filesystem.processed_dir, self.filesystem.metadata_dir)),
            "filesystem_location": str(self.filesystem.root),
            "filesystem_free_bytes": disk_usage(self.filesystem.root).free,
            "postgresql": {**postgres_status, "schema": schema},
            "last_initialization_result": self.last_initialization,
        }
=======
import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any

from .postgres_storage import PostgreSQLStorage
from .storage_service import FileSystemStorage

DEFAULT_POSTGRES_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "database": "simple_etl_studio_db",
    "username": "postgres",
    "maintenance_database": "postgres",
}


class StorageConfiguration:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._settings = self._read()
        self._apply_environment_defaults()
        self._credential_store_available = True
        environment_password = os.getenv("POSTGRES_PASSWORD")
        try:
            stored_password = self._read_keyring_password()
        except RuntimeError:
            self._credential_store_available = False
            stored_password = None
        self._password = environment_password or stored_password
        self._password_source = "environment" if environment_password else "credential_store" if stored_password else None

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {
                "active_backend": "filesystem",
                "postgres": dict(DEFAULT_POSTGRES_CONFIG),
                "last_successful_connection": None,
                "last_initialization": None,
            }
        try:
            with self.path.open("r", encoding="utf-8") as file:
                data = json.load(file)
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError("Storage configuration could not be read.") from exc
        if not isinstance(data, dict) or data.get("active_backend", "filesystem") not in {"filesystem", "postgresql"}:
            raise RuntimeError("Storage configuration is invalid.")
        postgres = data.get("postgres")
        if not isinstance(postgres, dict):
            postgres = {}
        return {
            "active_backend": data.get("active_backend", "filesystem"),
            "postgres": {**DEFAULT_POSTGRES_CONFIG, **postgres},
            "last_successful_connection": data.get("last_successful_connection"),
            "last_initialization": data.get("last_initialization"),
        }

    def _apply_environment_defaults(self) -> None:
        postgres = self._settings["postgres"]
        postgres["host"] = os.getenv("POSTGRES_HOST", postgres["host"])
        postgres["port"] = int(os.getenv("POSTGRES_PORT", postgres["port"]))
        postgres["database"] = os.getenv("POSTGRES_DB", postgres["database"])
        postgres["username"] = os.getenv("POSTGRES_USER", postgres["username"])
        postgres["maintenance_database"] = os.getenv("POSTGRES_MAINTENANCE_DB", postgres["maintenance_database"])

    @staticmethod
    def _read_keyring_password() -> str | None:
        try:
            import keyring
        except ImportError as exc:
            raise RuntimeError("The secure credential-store package is not installed.") from exc
        try:
            return keyring.get_password("simple-etl-studio", "postgresql")
        except keyring.errors.NoKeyringError as exc:
            raise RuntimeError("The operating system has no secure credential store configured.") from exc
        except Exception as exc:
            raise RuntimeError("The secure credential store could not be read.") from exc

    def _write(self) -> None:
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as file:
                json.dump(self._settings, file, ensure_ascii=False, indent=2)
                file.write("\n")
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        finally:
            temporary.unlink(missing_ok=True)

    @property
    def active_backend(self) -> str:
        return self._settings["active_backend"]

    @property
    def postgres(self) -> dict[str, Any]:
        return dict(self._settings["postgres"])

    @property
    def password(self) -> str | None:
        return self._password

    @property
    def last_successful_connection(self) -> str | None:
        return self._settings["last_successful_connection"]

    @property
    def last_initialization(self) -> dict[str, Any] | None:
        return self._settings["last_initialization"]

    @property
    def password_saved(self) -> bool:
        return bool(self._password)

    @property
    def password_source(self) -> str | None:
        return self._password_source

    @property
    def credential_store_available(self) -> bool:
        return self._credential_store_available

    def save_postgres(self, config: dict[str, Any], password: str | None, clear_password: bool = False) -> None:
        previous = self._settings
        previous_password = self._password
        previous_source = self._password_source
        keyring = None
        old_stored_password = None
        credential_changed = False
        self._settings = {**self._settings, "postgres": dict(config)}
        try:
            if password:
                import keyring

                if os.getenv("POSTGRES_PASSWORD"):
                    raise RuntimeError(
                        "POSTGRES_PASSWORD is configured in the environment. Update that variable instead of saving an OS credential."
                    )
                old_stored_password = keyring.get_password("simple-etl-studio", "postgresql")
                keyring.set_password("simple-etl-studio", "postgresql", password)
                credential_changed = True
                self._password = password
                self._password_source = "credential_store"
            elif clear_password:
                import keyring

                old_stored_password = keyring.get_password("simple-etl-studio", "postgresql")
                if old_stored_password is not None:
                    keyring.delete_password("simple-etl-studio", "postgresql")
                    credential_changed = True
                environment_password = os.getenv("POSTGRES_PASSWORD")
                self._password = environment_password
                self._password_source = "environment" if environment_password else None
            self._write()
        except Exception as exc:
            self._settings = previous
            self._password = previous_password
            self._password_source = previous_source
            if credential_changed:
                try:
                    if old_stored_password is None:
                        keyring.delete_password("simple-etl-studio", "postgresql")
                    else:
                        keyring.set_password("simple-etl-studio", "postgresql", old_stored_password)
                except Exception as rollback_error:
                    raise RuntimeError(
                        "Settings could not be saved and the secure credential could not be restored."
                    ) from rollback_error
            raise RuntimeError("The database settings could not be saved to secure local storage.") from exc

    def set_active_backend(self, backend: str) -> None:
        previous = self._settings
        self._settings = {**self._settings, "active_backend": backend}
        try:
            self._write()
        except Exception:
            self._settings = previous
            raise

    def mark_connection_success(self, timestamp: str) -> None:
        previous = self._settings
        self._settings = {**self._settings, "last_successful_connection": timestamp}
        try:
            self._write()
        except Exception:
            self._settings = previous
            raise

    def mark_initialization(self, result: dict[str, Any]) -> None:
        previous = self._settings
        self._settings = {**self._settings, "last_initialization": result}
        try:
            self._write()
        except Exception:
            self._settings = previous
            raise


class StorageManager:
    def __init__(self, filesystem: FileSystemStorage, configuration: StorageConfiguration):
        self.filesystem = filesystem
        self.configuration = configuration
        self.postgresql = PostgreSQLStorage(configuration)
        self._switch_lock = threading.RLock()
        self._metadata_backend = self.postgresql if configuration.active_backend == "postgresql" else None

    @property
    def active_backend(self) -> str:
        with self._switch_lock:
            return self.configuration.active_backend

    @property
    def metadata_backend(self):
        with self._switch_lock:
            return self._metadata_backend

    def activate(self, backend: str) -> None:
        with self._switch_lock:
            self.configuration.set_active_backend(backend)
            self._metadata_backend = self.postgresql if backend == "postgresql" else None

    def __getattr__(self, name: str) -> Any:
        return getattr(self.filesystem, name)
>>>>>>> cabfcff74dd1bdc17781142a1c5b05739a95b821
