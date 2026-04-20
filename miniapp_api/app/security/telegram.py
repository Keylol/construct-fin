"""Telegram Mini App initData verification helpers."""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl


class TelegramInitDataError(ValueError):
    """Raised when initData cannot be verified."""


@dataclass(frozen=True)
class TelegramUserPayload:
    """Validated Telegram user payload."""

    telegram_user_id: int
    first_name: str
    last_name: str | None
    username: str | None
    language_code: str | None
    auth_date: datetime
    raw_init_data: str


def _data_check_string(items: list[tuple[str, str]]) -> str:
    rows = [f"{key}={value}" for key, value in sorted(items, key=lambda pair: pair[0]) if key != "hash"]
    return "\n".join(rows)


def verify_telegram_init_data(
    *,
    init_data: str,
    bot_token: str,
    max_age_seconds: int = 24 * 60 * 60,
) -> TelegramUserPayload:
    """Verifies Telegram initData using official HMAC algorithm."""

    if not init_data:
        raise TelegramInitDataError("initData is empty")
    if not bot_token:
        raise TelegramInitDataError("Telegram bot token is not configured")

    parsed = parse_qsl(init_data, keep_blank_values=True)
    payload = dict(parsed)
    given_hash = payload.get("hash")
    if not given_hash:
        raise TelegramInitDataError("initData hash is missing")

    check_string = _data_check_string(parsed)
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    calculated_hash = hmac.new(secret_key, check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(given_hash, calculated_hash):
        raise TelegramInitDataError("initData hash mismatch")

    auth_date_raw = payload.get("auth_date", "")
    if not auth_date_raw.isdigit():
        raise TelegramInitDataError("auth_date is invalid")
    auth_date = datetime.fromtimestamp(int(auth_date_raw), tz=UTC)
    if datetime.now(tz=UTC) - auth_date > timedelta(seconds=max_age_seconds):
        raise TelegramInitDataError("initData is expired")

    user_raw = payload.get("user")
    if not user_raw:
        raise TelegramInitDataError("user payload is missing")
    try:
        user = json.loads(user_raw)
    except json.JSONDecodeError as exc:
        raise TelegramInitDataError("user payload is invalid JSON") from exc

    user_id = user.get("id")
    first_name = str(user.get("first_name") or "").strip()
    if not isinstance(user_id, int) or not first_name:
        raise TelegramInitDataError("user payload is incomplete")

    return TelegramUserPayload(
        telegram_user_id=user_id,
        first_name=first_name,
        last_name=(str(user.get("last_name")).strip() if user.get("last_name") else None),
        username=(str(user.get("username")).strip() if user.get("username") else None),
        language_code=(str(user.get("language_code")).strip() if user.get("language_code") else None),
        auth_date=auth_date,
        raw_init_data=init_data,
    )
