import os
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")


def default_config() -> dict[str, object]:
    storage_mode = os.getenv("STORAGE_MODE", "local").strip().lower()
    if storage_mode not in {"local", "server"}:
        raise ValueError("STORAGE_MODE must be 'local' or 'server'.")
    active_storage_backend = os.getenv("ACTIVE_STORAGE_BACKEND", "filesystem").strip().lower()
    if active_storage_backend not in {"filesystem", "postgresql"}:
        raise ValueError("ACTIVE_STORAGE_BACKEND must be 'filesystem' or 'postgresql'.")

    storage_value = Path(os.getenv("STORAGE_ROOT", "storage"))
    storage_root = storage_value if storage_value.is_absolute() else PROJECT_ROOT / storage_value
    frontend_root = Path(os.getenv("FRONTEND_ROOT", PROJECT_ROOT / "frontend")).resolve()
    origins = os.getenv(
        "FRONTEND_ORIGINS",
        "http://127.0.0.1:5000,http://localhost:5000,http://127.0.0.1:5173,http://localhost:5173",
    )
    return {
        "AUTH_ENABLED": os.getenv("AUTH_ENABLED", "true").strip().lower() not in {"0", "false", "no"},
        "AUTH_COOKIE_SECURE": os.getenv("AUTH_COOKIE_SECURE", "false").strip().lower() in {"1", "true", "yes"},
        "SECRET_KEY": os.getenv("FLASK_SECRET_KEY") or os.getenv("SECRET_KEY"),
        "STORAGE_MODE": storage_mode,
        "ACTIVE_STORAGE_BACKEND": active_storage_backend,
        "STORAGE_ROOT": storage_root.resolve(),
        "FRONTEND_ROOT": frontend_root,
        "MAX_UPLOAD_SIZE_MB": max(1, int(os.getenv("MAX_UPLOAD_SIZE_MB", "100"))),
        "CORS_ORIGINS": [origin.strip() for origin in origins.split(",") if origin.strip()],
        "HOST": os.getenv("HOST", "127.0.0.1"),
        "PORT": int(os.getenv("PORT", "5000")),
        "DEBUG": os.getenv("FLASK_DEBUG", "false").strip().lower() in {"1", "true", "yes"},
        "CONNECTIONS_API_TOKEN": os.getenv("CONNECTIONS_API_TOKEN", ""),
    }