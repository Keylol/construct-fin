"""Runtime settings for Mini App API."""

from __future__ import annotations

from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_env: str = "development"
    api_host: str = "0.0.0.0"
    api_port: int = 8080
    api_base_path: str = "/api/v1"
    jwt_secret: str = "change_me_for_prod"
    jwt_ttl_seconds: int = 8 * 60 * 60

    # For real deployment use PostgreSQL URL, for local bootstrap this fallback works.
    miniapp_database_url: str = "sqlite+aiosqlite:///./data/miniapp_dev.db"
    miniapp_documents_dir: str = "./data/miniapp_documents"
    miniapp_max_upload_mb: int = 50
    miniapp_report_default_days: int = 7
    miniapp_soft_launch_owner_only: bool = False
    miniapp_soft_launch_operator_user_ids: str = ""
    miniapp_notification_mode: str = "critical_only"
    miniapp_rate_limit_enabled: bool = True
    miniapp_rate_limit_window_seconds: int = 60
    miniapp_rate_limit_general_per_window: int = 240
    miniapp_rate_limit_write_per_window: int = 120
    miniapp_rate_limit_auth_per_window: int = 30
    miniapp_cors_origins: str = (
        "http://localhost:8080,http://127.0.0.1:8080,http://localhost:8081,http://127.0.0.1:8081"
    )

    telegram_bot_token: str = ""
    allowed_user_ids: str = ""
    owner_user_ids: str = ""
    operator_user_ids: str = ""

    @field_validator("api_base_path", mode="after")
    @classmethod
    def _normalize_api_base_path(cls, value: str) -> str:
        trimmed = str(value or "/api/v1").strip()
        if not trimmed.startswith("/"):
            trimmed = f"/{trimmed}"
        return trimmed.rstrip("/")

    @field_validator(
        "miniapp_rate_limit_window_seconds",
        "miniapp_rate_limit_general_per_window",
        "miniapp_rate_limit_write_per_window",
        "miniapp_rate_limit_auth_per_window",
        mode="after",
    )
    @classmethod
    def _ensure_positive_ints(cls, value: int) -> int:
        return max(1, int(value))

    @property
    def cors_origins(self) -> list[str]:
        raw = str(self.miniapp_cors_origins or "").strip()
        if not raw:
            return ["*"]
        return [item.strip() for item in raw.split(",") if item.strip()]

    @staticmethod
    def _parse_ids(raw_value: str) -> set[int]:
        result: set[int] = set()
        for chunk in str(raw_value or "").split(","):
            cleaned = chunk.strip()
            if cleaned.isdigit():
                result.add(int(cleaned))
        return result

    @property
    def owner_ids(self) -> set[int]:
        return self._parse_ids(self.owner_user_ids)

    @property
    def operator_ids(self) -> set[int]:
        return self._parse_ids(self.operator_user_ids)

    @property
    def allowed_ids(self) -> set[int]:
        return self._parse_ids(self.allowed_user_ids)

    @property
    def soft_launch_operator_ids(self) -> set[int]:
        return self._parse_ids(self.miniapp_soft_launch_operator_user_ids)

    @property
    def has_explicit_miniapp_roles(self) -> bool:
        return bool(self.owner_ids or self.operator_ids)

    @property
    def uses_legacy_allowed_ids_for_miniapp(self) -> bool:
        return bool(self.allowed_ids) and not self.has_explicit_miniapp_roles

    @property
    def jwt_secret_is_weak(self) -> bool:
        secret = str(self.jwt_secret or "").strip()
        return secret == "change_me_for_prod" or len(secret) < 32


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Returns cached settings instance."""

    return Settings()
