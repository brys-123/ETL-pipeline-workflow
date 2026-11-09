from datetime import datetime, timezone
from hmac import compare_digest

from flask import g, jsonify, redirect, request

from ..routes.auth import clear_auth_cookies, valid_csrf_token
from ..services.auth_service import AuthService, is_session_expired, public_user
from ..services.storage_manager_types import StorageUnavailableError

_PUBLIC_API_PATHS = {
    "/api/auth/status",
    "/api/auth/register",
    "/api/auth/login",
    "/api/health",
}
_PUBLIC_PAGE_PATHS = {"/login", "/signup", "/forgot-password"}
_STATE_CHANGING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def register_authentication_middleware(app) -> None:
    @app.before_request
    def authenticate_request():
        g.current_user = None
        g.auth_session = None
        g.auth_session_expired = False
        if not app.config.get("AUTH_ENABLED", True) or request.method == "OPTIONS":
            return None

        manager = app.extensions["etl_storage"]
        session_token = request.cookies.get("simple_etl_session")
        if session_token:
            try:
                service = AuthService(manager)
                session = service.get_session(session_token)
                if session and not is_session_expired(session):
                    user = service.get_user(session.get("user_id", ""))
                    if user and user.get("status") == "active":
                        g.current_user = public_user(user)
                        g.auth_session = session
                        last_activity = datetime.fromisoformat(session["last_activity_at"].replace("Z", "+00:00"))
                        if last_activity.tzinfo is None:
                            last_activity = last_activity.replace(tzinfo=timezone.utc)
                        if (datetime.now(timezone.utc) - last_activity).total_seconds() >= 60:
                            service.touch_session(session)
                    else:
                        service.revoke_session(session)
                        g.auth_session_expired = True
                elif session:
                    service.revoke_session(session)
                    g.auth_session_expired = True
            except (OSError, RuntimeError, StorageUnavailableError):
                app.logger.exception("Authentication storage is unavailable.")
                if request.path.startswith("/api/") and request.path != "/api/health":
                    return jsonify({"error": "The active storage backend is unavailable."}), 503

        if request.path == "/":
            return None if g.current_user else redirect("/login")
        if request.path.startswith("/api/") and request.path not in _PUBLIC_API_PATHS:
            if not g.current_user:
                return jsonify({"error": "Authentication is required."}), 401
        elif not request.path.startswith("/api/") and request.path not in _PUBLIC_PAGE_PATHS and not (
            request.path.startswith(("/css/", "/js/", "/vendor/"))
        ) and not g.current_user:
            return jsonify({"error": "Authentication is required."}), 401

        if request.method in _STATE_CHANGING_METHODS:
            cookie_token = request.cookies.get("simple_etl_csrf", "")
            header_token = request.headers.get("X-CSRF-Token", "")
            if (
                not valid_csrf_token(cookie_token)
                or not compare_digest(cookie_token, header_token)
                or g.auth_session and not compare_digest(
                    AuthService.hash_csrf(cookie_token), g.auth_session.get("csrf_hash", "")
                )
            ):
                return jsonify({"error": "The request could not be verified. Refresh the page and try again."}), 400
        return None

    @app.after_request
    def secure_auth_response(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        if request.path == "/" or request.path in _PUBLIC_PAGE_PATHS or request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        if getattr(g, "auth_session_expired", False):
            clear_auth_cookies(response)
        return response
