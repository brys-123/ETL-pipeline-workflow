import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from hmac import compare_digest, new as hmac_new

from flask import Blueprint, current_app, g, jsonify, request, send_file
from werkzeug.security import check_password_hash

from ..services.auth_service import AuthService, is_session_expired, public_user
from ..services.storage_manager_types import StorageUnavailableError

auth_blueprint = Blueprint("auth", __name__)
_rate_lock = threading.Lock()
_rate_buckets: dict[tuple[str, str, str], list[float]] = {}
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
EMAIL_PATTERN = re.compile(r"^[^@\s]{1,128}@[^@\s.]+(?:\.[^@\s.]+)+$")


def _service() -> AuthService:
    return AuthService(current_app.extensions["etl_storage"])


def _csrf_signature(nonce: str) -> str:
    secret = current_app.config["SECRET_KEY"].encode("utf-8")
    return hmac_new(secret, f"auth-csrf:{nonce}".encode("utf-8"), "sha256").hexdigest()


def make_csrf_token() -> str:
    nonce = secrets.token_urlsafe(24)
    return f"{nonce}.{_csrf_signature(nonce)}"


def valid_csrf_token(token: str) -> bool:
    try:
        nonce, signature = token.rsplit(".", 1)
    except ValueError:
        return False
    return bool(nonce) and compare_digest(signature, _csrf_signature(nonce))


def set_auth_cookies(response, csrf_token: str, *, session_token: str | None = None, remember: bool = False):
    secure = bool(current_app.config.get("AUTH_COOKIE_SECURE")) or request.is_secure
    response.set_cookie(
        "simple_etl_csrf",
        csrf_token,
        httponly=False,
        secure=secure,
        samesite="Lax",
        path="/",
        max_age=30 * 24 * 60 * 60 if remember else None,
    )
    if session_token is not None:
        response.set_cookie(
            "simple_etl_session",
            session_token,
            httponly=True,
            secure=secure,
            samesite="Lax",
            path="/",
            max_age=30 * 24 * 60 * 60 if remember else None,
        )
    return response


def clear_auth_cookies(response):
    secure = bool(current_app.config.get("AUTH_COOKIE_SECURE")) or request.is_secure
    response.delete_cookie("simple_etl_session", path="/", secure=secure, httponly=True, samesite="Lax")
    response.delete_cookie("simple_etl_csrf", path="/", secure=secure, httponly=False, samesite="Lax")
    return response


def _rate_limit(action: str, maximum: int, window: int):
    now = time.monotonic()
    key = (str(id(current_app._get_current_object())), action, request.remote_addr or "unknown")
    with _rate_lock:
        bucket = [stamp for stamp in _rate_buckets.get(key, []) if now - stamp < window]
        if len(bucket) >= maximum:
            _rate_buckets[key] = bucket
            return True
        bucket.append(now)
        _rate_buckets[key] = bucket
        if len(_rate_buckets) > 4096:
            expired = {bucket_key for bucket_key, stamps in _rate_buckets.items() if not stamps or now - stamps[-1] > 3600}
            for bucket_key in expired:
                _rate_buckets.pop(bucket_key, None)
    return False


def require_admin(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        user = getattr(g, "current_user", None)
        if not user:
            return jsonify({"error": "Authentication is required."}), 401
        if user.get("role") != "admin":
            return jsonify({"error": "Administrator access is required."}), 403
        return function(*args, **kwargs)

    return wrapped


def _valid_password(password: str) -> bool:
    return (
        12 <= len(password) <= 128
        and any(char.islower() for char in password)
        and any(char.isupper() for char in password)
        and any(char.isdigit() for char in password)
    )


def _validate_profile(payload: object, *, registration: bool = False):
    if not isinstance(payload, dict):
        return None, "Request body must be an object."
    full_name = payload.get("full_name", "")
    if not isinstance(full_name, str) or not full_name.strip() or len(full_name.strip()) > 100:
        return None, "Full name is required and must be 100 characters or fewer."
    username = payload.get("username", "")
    if not isinstance(username, str) or not USERNAME_PATTERN.fullmatch(username.strip()):
        return None, "Username must be 3–32 characters using letters, numbers, periods, underscores, or hyphens."
    email = payload.get("email", "")
    if not isinstance(email, str) or len(email.strip()) > 254 or not EMAIL_PATTERN.fullmatch(email.strip()):
        return None, "Enter a valid email address."
    password = payload.get("password", "")
    if registration and (not isinstance(password, str) or not _valid_password(password)):
        return None, "Password must be 12–128 characters and include uppercase, lowercase, and a number."
    if registration and payload.get("confirm_password") != password:
        return None, "Password confirmation does not match."
    return {
        "full_name": full_name.strip(),
        "username": username.strip().casefold(),
        "email": email.strip().casefold(),
        "password": password,
    }, None


def _new_authenticated_session(user: dict, remember: bool, action: str):
    service = _service()
    csrf_token = make_csrf_token()
    token, session = service.create_session(
        user["id"],
        csrf_token,
        remember,
        request.remote_addr,
        request.user_agent.string,
    )
    service.log_activity(user["id"], action, request.remote_addr)
    response = jsonify({"authenticated": True, "user": public_user(user), "csrf_token": csrf_token})
    return set_auth_cookies(response, csrf_token, session_token=token, remember=remember)


@auth_blueprint.get("/auth/status")
def auth_status():
    storage = current_app.extensions["etl_storage"]
    if storage.active_backend == "postgresql":
        try:
            if not storage.postgresql.schema_status().get("initialized"):
                return jsonify({"error": "The active PostgreSQL storage backend is not initialized."}), 503
        except RuntimeError as exc:
            current_app.logger.exception("Authentication storage availability check failed: %s", exc)
            return jsonify({
                "error": "The active PostgreSQL storage backend is unavailable. Check its connection and initialization."
            }), 503
    token = request.cookies.get("simple_etl_csrf", "")
    session = getattr(g, "auth_session", None)
    if not valid_csrf_token(token) or session and not compare_digest(
        _service().hash_csrf(token), session.get("csrf_hash", "")
    ):
        token = make_csrf_token()
        if session:
            session["csrf_hash"] = _service().hash_csrf(token)
            _service().touch_session(session)
    response = jsonify({
        "authenticated": bool(getattr(g, "current_user", None)),
        "user": public_user(g.current_user) if getattr(g, "current_user", None) else None,
        "csrf_token": token,
    })
    response.headers["Cache-Control"] = "no-store"
    return set_auth_cookies(response, token)


@auth_blueprint.post("/auth/register")
def register():
    if _rate_limit("register", 8, 3600):
        return jsonify({"error": "Too many registration attempts. Try again later."}), 429
    normalized, error = _validate_profile(request.get_json(silent=True), registration=True)
    if error:
        return jsonify({"error": error}), 400
    service = _service()
    try:
        if service.get_user_by_identity(normalized["username"]) or service.get_user_by_identity(normalized["email"]):
            return jsonify({"error": "An account already uses that username or email address."}), 409
        user = service.create_user(**normalized, role="user")
        user["last_login_at"] = datetime.now(timezone.utc).isoformat()
        service.save_user(user)
        return _new_authenticated_session(user, False, "register")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 409
    except (OSError, RuntimeError, StorageUnavailableError) as exc:
        current_app.logger.exception("User registration could not be completed: %s", exc)
        return jsonify({"error": "The active storage backend is unavailable. Registration was not completed."}), 503


@auth_blueprint.post("/auth/login")
def login():
    if _rate_limit("login", 20, 900):
        return jsonify({"error": "Too many login attempts. Try again in 15 minutes."}), 429
    payload = request.get_json(silent=True)
    identity = payload.get("identity", payload.get("username_or_email", "")) if isinstance(payload, dict) else ""
    password = payload.get("password", "") if isinstance(payload, dict) else ""
    remember = payload.get("remember", False) if isinstance(payload, dict) else False
    if not isinstance(identity, str) or not identity.strip() or not isinstance(password, str) or not password or not isinstance(remember, bool):
        return jsonify({"error": "Enter a username or email and password."}), 400
    service = _service()
    try:
        user = service.get_user_by_identity(identity)
        if user is None:
            service.log_activity(None, "login_failed", request.remote_addr)
            return jsonify({"error": "Invalid username/email or password."}), 401
        locked_until = user.get("locked_until")
        if user.get("status") == "disabled":
            return jsonify({"error": "This account is disabled. Contact an administrator."}), 403
        if user.get("status") == "locked":
            return jsonify({"error": "This account is locked. Contact an administrator."}), 423
        if locked_until:
            parsed = datetime.fromisoformat(locked_until.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            if parsed > datetime.now(timezone.utc):
                return jsonify({"error": "This account is temporarily locked. Try again later."}), 423
        if not check_password_hash(user["password_hash"], password):
            attempts = int(user.get("failed_login_count") or 0) + 1
            user["failed_login_count"] = attempts
            if attempts >= 5:
                user["locked_until"] = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()
                user["failed_login_count"] = 0
            service.save_user(user)
            service.log_activity(user["id"], "login_failed", request.remote_addr)
            return jsonify({"error": "Invalid username/email or password."}), 401
        user["failed_login_count"] = 0
        user["locked_until"] = None
        user["last_login_at"] = datetime.now(timezone.utc).isoformat()
        service.save_user(user)
        return _new_authenticated_session(user, remember, "login")
    except (OSError, RuntimeError, StorageUnavailableError) as exc:
        current_app.logger.exception("Login could not be completed: %s", exc)
        return jsonify({"error": "The active storage backend is unavailable. Login could not be completed."}), 503


@auth_blueprint.post("/auth/logout")
def logout():
    session = getattr(g, "auth_session", None)
    if session:
        try:
            service = _service()
            service.revoke_session(session)
            service.log_activity(session.get("user_id"), "logout", request.remote_addr)
        except (OSError, RuntimeError, StorageUnavailableError) as exc:
            current_app.logger.exception("Session revocation failed during logout: %s", exc)
            return jsonify({"error": "The session could not be revoked because the active storage backend is unavailable."}), 503
    return clear_auth_cookies(jsonify({"authenticated": False, "logged_out": True}))


@auth_blueprint.get("/auth/me")
def auth_me():
    return jsonify({"user": public_user(g.current_user)})


@auth_blueprint.patch("/auth/profile")
def update_profile():
    payload = request.get_json(silent=True)
    normalized, error = _validate_profile(payload)
    if error:
        return jsonify({"error": error}), 400
    service = _service()
    user = service.get_user(g.current_user["id"])
    if user is None:
        return jsonify({"error": "Account not found."}), 404
    if normalized["username"] != user["username"]:
        return jsonify({"error": "Username changes are not currently supported."}), 400
    other_email = service.get_user_by_identity(normalized["email"])
    if other_email and other_email["id"] != user["id"]:
        return jsonify({"error": "That email address is already in use."}), 409
    user["full_name"] = normalized["full_name"]
    user["email"] = normalized["email"]
    service.save_user(user)
    service.log_activity(user["id"], "profile_updated", request.remote_addr)
    return jsonify({"user": public_user(user)})


@auth_blueprint.post("/auth/profile-picture")
def update_profile_picture():
    uploaded = request.files.get("picture")
    if uploaded is None:
        return jsonify({"error": "Choose a profile picture to upload."}), 400
    content = uploaded.stream.read(2 * 1024 * 1024 + 1)
    if len(content) > 2 * 1024 * 1024:
        return jsonify({"error": "Profile pictures must be 2 MB or smaller."}), 413
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        extension = ".png"
    elif content.startswith(b"\xff\xd8\xff"):
        extension = ".jpg"
    elif content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        extension = ".webp"
    else:
        return jsonify({"error": "Choose a valid PNG, JPEG, or WebP image."}), 400
    service = _service()
    user = service.get_user(g.current_user["id"])
    if user is None:
        return jsonify({"error": "Account not found."}), 404
    try:
        old_picture = user.get("profile_picture")
        user["profile_picture"] = service.store_profile_picture(user, content, extension)
        service.save_user(user)
        if old_picture and old_picture != user["profile_picture"]:
            old_extension = old_picture.rsplit("/", 1)[-1]
            old_path = service.profile_picture_path({**user, "profile_picture": old_picture}, old_extension)
            if old_path:
                old_path.unlink(missing_ok=True)
        service.log_activity(user["id"], "profile_picture_updated", request.remote_addr)
    except (OSError, RuntimeError) as exc:
        current_app.logger.exception("Profile picture could not be saved: %s", exc)
        return jsonify({"error": "The profile picture could not be saved."}), 500
    return jsonify({"user": public_user(user)})


@auth_blueprint.get("/auth/profile-picture/<extension>")
def get_profile_picture(extension: str):
    service = _service()
    path = service.profile_picture_path(g.current_user, extension)
    if path is None:
        return jsonify({"error": "Profile picture not found."}), 404
    content_type = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[extension]
    return send_file(path, mimetype=content_type, conditional=False, max_age=0)


@auth_blueprint.post("/auth/password")
def change_password():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Request body must be an object."}), 400
    current_password = payload.get("current_password")
    password = payload.get("password")
    if not isinstance(current_password, str) or not isinstance(password, str):
        return jsonify({"error": "Enter your current password and a new password."}), 400
    if not _valid_password(password):
        return jsonify({"error": "Password must be 12–128 characters and include uppercase, lowercase, and a number."}), 400
    if payload.get("confirm_password") != password:
        return jsonify({"error": "Password confirmation does not match."}), 400
    service = _service()
    user = service.get_user(g.current_user["id"])
    if user is None or not check_password_hash(user["password_hash"], current_password):
        return jsonify({"error": "Current password is incorrect."}), 403
    user["password_hash"] = service.password_hash(password)
    service.save_user(user)
    service.revoke_other_sessions(user["id"], g.auth_session["id"])
    service.log_activity(user["id"], "password_changed", request.remote_addr)
    return jsonify({"changed": True})


@auth_blueprint.get("/admin/users")
@require_admin
def admin_users():
    service = _service()
    return jsonify({"users": service.list_users()})


@auth_blueprint.patch("/admin/users/<user_id>")
@require_admin
def admin_update_user(user_id: str):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or set(payload) - {"status", "role"}:
        return jsonify({"error": "Only role and account status can be changed here."}), 400
    service = _service()
    user = service.get_user(user_id)
    if user is None:
        return jsonify({"error": "Account not found."}), 404
    role = payload.get("role", user["role"])
    account_status = payload.get("status", user["status"])
    if role not in {"user", "admin"} or account_status not in {"active", "disabled"}:
        return jsonify({"error": "Role or account status is invalid."}), 400
    if user["id"] == g.current_user["id"] and (role != "admin" or account_status != "active"):
        return jsonify({"error": "You cannot remove your own administrator access or disable your account."}), 400
    user["role"] = role
    user["status"] = account_status
    service.save_user(user)
    service.log_activity(g.current_user["id"], "account_admin_updated", request.remote_addr, user_id)
    return jsonify({"user": public_user(user)})


@auth_blueprint.get("/admin/activity")
@require_admin
def admin_activity():
    return jsonify({"activity": _service().list_activity(limit=request.args.get("limit", 100, type=int))})


@auth_blueprint.get("/admin/sessions")
@require_admin
def admin_sessions():
    repository = _service().repository
    if hasattr(repository, "list_sessions"):
        sessions = repository.list_sessions(limit=request.args.get("limit", 100, type=int))
        return jsonify({"sessions": sessions})
    return jsonify({"sessions": []})
