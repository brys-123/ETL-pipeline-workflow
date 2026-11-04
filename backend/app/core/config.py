from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Universal ETL Studio"
    secret_key: str = "dev-secret-key"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24
    refresh_token_expire_days: int = 7
    database_url: str = "sqlite:///./etlstudio.db"
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/0"
    celery_result_backend: str = "redis://localhost:6379/0"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
