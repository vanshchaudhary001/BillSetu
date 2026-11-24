import os

from dotenv import load_dotenv
from pydantic import BaseModel, Field

load_dotenv()


class Settings(BaseModel):
    app_env: str = Field(default_factory=lambda: os.getenv("APP_ENV", "development"))
    gemini_api_key: str | None = Field(default_factory=lambda: os.getenv("GEMINI_API_KEY"))
    gemini_primary_model: str | None = Field(default_factory=lambda: os.getenv("GEMINI_PRIMARY_MODEL"))
    gemini_fallback_model: str | None = Field(default_factory=lambda: os.getenv("GEMINI_FALLBACK_MODEL"))
    max_upload_bytes: int = Field(default_factory=lambda: int(os.getenv("MAX_UPLOAD_BYTES", "10485760")))
    storage_root: str = Field(default_factory=lambda: os.getenv("DOCUMENT_STORAGE_ROOT", ".data/private-documents"))
    cors_allowed_origins: list[str] = Field(
        default_factory=lambda: [
            origin.strip()
            for origin in os.getenv(
                "CORS_ALLOWED_ORIGINS",
                "http://localhost:4173,http://127.0.0.1:4173",
            ).split(",")
            if origin.strip()
        ]
    )


settings = Settings()