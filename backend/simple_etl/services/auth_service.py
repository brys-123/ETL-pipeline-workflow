import hashlib
import json
import os
import secrets
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from werkzeug.security import check_password_hash, generate_password_hash

from .storage_manager_types import StorageUnavailableError

_filesystem_lock = threading.RLock()


def _utc_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except ValueError:
        return None


def _public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        key: user.get(key)
        for key in ("id", "full_name", "username", "email", "profile_picture", "role", "status", "created_at", "last_login_at")
    }


class FilesystemAuthRepository:
    def __init__(self, storage):
        self.root = storage.root / "auth"
        self.users_path = self.root / "users.json"
        self.sessions_path = self.root / "sessions.json"
        self.activity_path = self.root / "activity.json"
        for path in (self.root, self.root / "profiles"):
            path.mkdir(parents=True, exist_ok=True)

    def _read(self, path: Path, default: Any) -> Any:
        return self._filesystem_read(path, default)

    @staticmethod
    def _filesystem_read(path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        try:
            with path.open("r", encoding="utf-8") as source:
                return json.load(source)
        except (OSError, json.JSONDecodeError) as exc:
            raise StorageUnavailableError("Authentication storage could not be read.") from exc

    @staticmethod
    def _write(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as destination:
                json.dump(value, destination, ensure_ascii=False, indent=2)
                destination.write("\n")
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, path)
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
        finally:
            temporary.unlink(missing_ok=True)

    def users(self) -> list[dict[str, Any]]:
        with _filesystem_lock:
            users = self._read(self.users_path, [])
            if not isinstance(users, list) or any(not isinstance(user, dict) for user in users):
                raise StorageUnavailableError("Authentication user records are invalid.")
            return users

    def save_user(self, user: dict[str, Any]) -> None:
        with _filesystem_lock:
            users = self.users()
            users = [item for item in users if item.get("id") != user["id"]]
            users.append(user)
            self._write(self.users_path, users)

    def user(self, user_id: str) -> dict[str, Any] | None:
        return next((user for user in self.users() if user.get("id") == user_id), None)

    def user_by_identity(self, identity: str) -> dict[str, Any] | None:
        return next(
            (user for user in self.users() if identity in {user.get("username"), user.get("email")}),
            None,
        )

    def session(self, token_hash: str) -> dict[str, Any] | None:
        with _filesystem_lock:
            sessions = self._read(self.sessions_path, [])
            if not isinstance(sessions, list):
                raise StorageUnavailableError("Authentication session records are invalid.")
            return next((item for item in sessions if item.get("token_hash") == token_hash), None)

    def list_sessions(self, limit: int = 100) -> list[dict[str, Any]]:
        with _filesystem_lock:
            sessions = self._read(self.sessions_path, [])
            users = {item["id"]: item for item in self.users()}
            results = []
            for session in sorted(sessions, key=lambda item: item.get("created_at", ""), reverse=True)[:max(1, min(1000, limit))]:
                results.append({
                    key: session.get(key)
                    for key in ("id", "user_id", "created_at", "last_activity_at", "expires_at", "ip_address", "user_agent", "remember", "revoked_at")
                } | {"username": users.get(session.get("user_id"), {}).get("username")})
            return results

    def save_session(self, session: dict[str, Any]) -> None:
        with _filesystem_lock:
            sessions = self._read(self.sessions_path, [])
            sessions = [item for item in sessions if item.get("id") != session["id"]]
            sessions.append(session)
            self._write(self.sessions_path, sessions)

    def update_sessions(self, user_id: str, *, session_id: str | None = None, revoke: bool = False) -> None:
        with _filesystem_lock:
            sessions = self._read(self.sessions_path, [])
            now = datetime.now(timezone.utc).isoformat()
            for session in sessions:
                if session.get("user_id") == user_id and (session_id is None or session.get("id") != session_id):
                    if revoke:
                        session["revoked_at"] = now
            self._write(self.sessions_path, sessions)

    def log_activity(self, item: dict[str, Any]) -> None:
        with _filesystem_lock:
            logs = self._read(self.activity_path, [])
            logs.append(item)
            self._write(self.activity_path, logs[-10000:])

    def list_activity(self, limit: int = 100) -> list[dict[str, Any]]:
        with _filesystem_lock:
            return list(reversed(self._read(self.activity_path, [])[-limit:]))


class AuthService:
    def __init__(self, manager):
        self.manager = manager

    @property
    def repository(self):
        backend = self.manager.metadata_backend
        return backend if backend is not None else FilesystemAuthRepository(self.manager.filesystem)

    @staticmethod
    def token_hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def new_csrf_token() -> str:
        return secrets.token_urlsafe(32)

    @staticmethod
    def hash_csrf(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def password_hash(password: str) -> str:
        return generate_password_hash(password, method="scrypt")

    @staticmethod
    def verify_password(password: str, password_hash: str) -> bool:
        try:
            return check_password_hash(password_hash, password)
        except (TypeError, ValueError):
            return False

    def list_users(self) -> list[dict[str, Any]]:
        records = self.repository.list_users() if hasattr(self.repository, "list_users") else self.repository.users()
        return [_public_user(item) for item in records]

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        return self.repository.get_user(user_id) if hasattr(self.repository, "get_user") else self.repository.user(user_id)

    def get_user_by_identity(self, identity: str) -> dict[str, Any] | None:
        normalized = identity.strip().casefold()
        return self.repository.get_user_by_identity(normalized) if hasattr(self.repository, "get_user_by_identity") else self.repository.user_by_identity(normalized)

    def create_user(self, *, full_name: str, username: str, email: str, password: str, role: str = "user") -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        user = {
            "id": secrets.token_hex(16),
            "full_name": full_name.strip(),
            "username": username.strip().casefold(),
            "email": email.strip().casefold(),
            "password_hash": self.password_hash(password),
            "profile_picture": None,
            "role": role,
            "status": "active",
            "created_at": now,
            "updated_at": now,
            "last_login_at": None,
            "failed_login_count": 0,
            "locked_until": None,
        }
        repository = self.repository
        if hasattr(repository, "create_user"):
            return repository.create_user(user)
        with _filesystem_lock:
            users = repository.users()
            if any(user["username"] == item.get("username") or user["email"] == item.get("email") for item in users):
                raise ValueError("An account already uses that username or email address.")
            users.append(user)
            repository._write(repository.users_path, users)
        return user

    def save_user(self, user: dict[str, Any]) -> None:
        user["updated_at"] = datetime.now(timezone.utc).isoformat()
        repository = self.repository
        if hasattr(repository, "save_user"):
            repository.save_user(user)
        else:
            repository.save_user(user)

    def create_session(self, user_id: str, csrf_token: str, remember: bool, ip_address: str | None, user_agent: str | None):
        now = datetime.now(timezone.utc)
        token = secrets.token_urlsafe(48)
        session_id = secrets.token_hex(16)
        duration = timedelta(days=30) if remember else timedelta(minutes=30)
        session = {
            "id": session_id,
            "user_id": user_id,
            "token_hash": self.token_hash(token),
            "csrf_hash": self.hash_csrf(csrf_token),
            "created_at": now.isoformat(),
            "last_activity_at": now.isoformat(),
            "expires_at": (now + duration).isoformat(),
            "idle_timeout_seconds": int(duration.total_seconds()),
            "ip_address": ip_address,
            "user_agent": (user_agent or "")[:512],
            "remember": remember,
            "revoked_at": None,
        }
        self.repository.save_session(session)
        return token, session

    def get_session(self, token: str) -> dict[str, Any] | None:
        repository = self.repository
        return repository.get_session(self.token_hash(token)) if hasattr(repository, "get_session") else repository.session(self.token_hash(token))

    def touch_session(self, session: dict[str, Any]) -> None:
        session["last_activity_at"] = datetime.now(timezone.utc).isoformat()
        self.repository.save_session(session)

    def revoke_session(self, session: dict[str, Any]) -> None:
        if hasattr(self.repository, "revoke_session"):
            self.repository.revoke_session(session["id"])
        else:
            session["revoked_at"] = datetime.now(timezone.utc).isoformat()
            self.repository.save_session(session)

    def revoke_other_sessions(self, user_id: str, current_session_id: str) -> None:
        if hasattr(self.repository, "revoke_user_sessions"):
            self.repository.revoke_user_sessions(user_id, except_session_id=current_session_id)
        else:
            self.repository.update_sessions(user_id, session_id=current_session_id, revoke=True)

    def log_activity(self, user_id: str | None, action: str, ip_address: str | None, description: str = "") -> None:
        record = {
            "id": secrets.token_hex(16),
            "user_id": user_id,
            "action": action,
            "description": description[:240],
            "ip_address": ip_address,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        repository = self.repository
        if hasattr(repository, "log_activity"):
            repository.log_activity(record)
        else:
            repository.record_activity(record)

    def list_activity(self, user_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        repository = self.repository
        records = repository.list_activity(limit) if hasattr(repository, "list_activity") else repository.get_activity(limit)
        return records if user_id is None else [item for item in records if item.get("user_id") == user_id]

    def store_profile_picture(self, user: dict[str, Any], content: bytes, extension: str) -> str:
        if extension not in {".png", ".jpg", ".webp"} or not content:
            raise ValueError("Choose a PNG, JPEG, or WebP profile picture.")
        directory = self.manager.filesystem.root / "auth" / "profiles"
        directory.mkdir(parents=True, exist_ok=True)
        path = (directory / f"{user['id']}{extension}").resolve()
        if path.parent != directory.resolve():
            raise ValueError("Invalid profile picture location.")
        temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
        try:
            with temporary.open("wb") as target:
                target.write(content)
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, path)
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
        finally:
            temporary.unlink(missing_ok=True)
        return f"/api/auth/profile-picture/{extension.removeprefix('.')}"

    def profile_picture_path(self, user: dict[str, Any], extension: str) -> Path | None:
        if extension not in {"png", "jpg", "webp"}:
            return None
        if user.get("profile_picture") != f"/api/auth/profile-picture/{extension}":
            return None
        directory = (self.manager.filesystem.root / "auth" / "profiles").resolve()
        path = (directory / f"{user['id']}.{extension}").resolve()
        if path.parent != directory or not path.is_file():
            return None
        return path


def is_session_expired(session: dict[str, Any]) -> bool:
    now = datetime.now(timezone.utc)
    expires_at = _utc_datetime(session.get("expires_at"))
    last_activity = _utc_datetime(session.get("last_activity_at"))
    timeout = int(session.get("idle_timeout_seconds") or 1800)
    return (
        session.get("revoked_at") is not None
        or expires_at is None
        or expires_at <= now
        or last_activity is None
        or now - last_activity > timedelta(seconds=timeout)
    )


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return _public_user(user)
