import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from pydantic import BaseModel, Field, field_validator


def _secure_cookie_default() -> bool:
    configured = os.getenv("AUTH_COOKIE_SECURE")
    if configured is not None:
        normalized = configured.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise ValueError("AUTH_COOKIE_SECURE must be a boolean value.")
    return os.getenv("APP_ENV", "development").strip().lower() in {"prod", "production"}


class Settings(BaseModel):
    app_env: str = Field(default_factory=lambda: os.getenv("APP_ENV", "development"))
    gemini_api_key: str | None = Field(default_factory=lambda: os.getenv("GEMINI_API_KEY"))
    gemini_primary_model: str | None = Field(default_factory=lambda: os.getenv("GEMINI_PRIMARY_MODEL"))
    gemini_fallback_model: str | None = Field(default_factory=lambda: os.getenv("GEMINI_FALLBACK_MODEL"))
    max_upload_bytes: int = Field(default_factory=lambda: int(os.getenv("MAX_UPLOAD_BYTES", "10485760")))
    storage_root: str = Field(
        default_factory=lambda: os.getenv(
            "DOCUMENT_STORAGE_ROOT",
            "/tmp/billsetu/private-documents" if os.getenv("VERCEL") else ".data/private-documents",
        )
    )
    auth_database_path: str = Field(
        default_factory=lambda: os.getenv(
            "AUTH_DATABASE_PATH",
            "/tmp/billsetu/auth.sqlite3" if os.getenv("VERCEL") else ".data/auth.sqlite3",
        )
    )
    auth_session_ttl_seconds: int = Field(
        default_factory=lambda: int(os.getenv("AUTH_SESSION_TTL_SECONDS", "43200")),
        gt=0,
    )
    auth_cookie_name: str = Field(
        default_factory=lambda: os.getenv("AUTH_COOKIE_NAME", "billsetu_session")
    )
    auth_cookie_secure: bool = Field(default_factory=_secure_cookie_default)
    cors_allowed_origins: list[str] = Field(
        default_factory=lambda: [
            origin.strip()
            for origin in os.getenv(
                "CORS_ALLOWED_ORIGINS",
                "http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173,https://billsetu-gamma.vercel.app,https://billsetu.vercel.app,https://billsetu-vanshchaudhary001s-projects.vercel.app",
            ).split(",")
            if origin.strip()
        ]
    )

    @field_validator("cors_allowed_origins")
    @classmethod
    def reject_wildcard_with_credentials(cls, origins: list[str]) -> list[str]:
        if "*" in origins:
            raise ValueError("CORS_ALLOWED_ORIGINS must list explicit origins when credentials are enabled.")
        return origins


settings = Settings()