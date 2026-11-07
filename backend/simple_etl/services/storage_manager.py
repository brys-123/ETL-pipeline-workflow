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
    "database": "simple_etl_db",
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
