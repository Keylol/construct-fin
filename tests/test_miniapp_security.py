from __future__ import annotations

import hashlib
import hmac
import json
from datetime import UTC, datetime
from urllib.parse import urlencode

import pytest

from miniapp_api.app.config import get_settings
from miniapp_api.app.main import create_app
from miniapp_api.app.deps import resolve_role_for_telegram_user
from miniapp_api.app.security.telegram import TelegramInitDataError, verify_telegram_init_data


def _build_init_data(bot_token: str, user: dict, auth_date: int) -> str:
    payload = {
        "auth_date": str(auth_date),
        "query_id": "AAHQE_TEST_QUERY",
        "user": json.dumps(user, ensure_ascii=False, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(payload.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    payload["hash"] = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    return urlencode(payload)


def test_verify_telegram_init_data_success():
    bot_token = "123456:TEST_TOKEN"
    now_ts = int(datetime.now(tz=UTC).timestamp())
    init_data = _build_init_data(
        bot_token=bot_token,
        auth_date=now_ts,
        user={
            "id": 12345,
            "first_name": "Alex",
            "last_name": "User",
            "username": "alex",
            "language_code": "ru",
        },
    )

    parsed = verify_telegram_init_data(init_data=init_data, bot_token=bot_token)
    assert parsed.telegram_user_id == 12345
    assert parsed.first_name == "Alex"
    assert parsed.username == "alex"


def test_verify_telegram_init_data_fails_on_tamper():
    bot_token = "123456:TEST_TOKEN"
    now_ts = int(datetime.now(tz=UTC).timestamp())
    init_data = _build_init_data(
        bot_token=bot_token,
        auth_date=now_ts,
        user={"id": 1, "first_name": "Bad"},
    )
    bad_data = init_data.replace("Bad", "Evil")
    with pytest.raises(TelegramInitDataError):
        verify_telegram_init_data(init_data=bad_data, bot_token=bot_token)


def test_resolve_role_for_telegram_user():
    assert resolve_role_for_telegram_user(telegram_user_id=10, owner_ids={10}, operator_ids={11}) == "owner"
    assert resolve_role_for_telegram_user(telegram_user_id=11, owner_ids={10}, operator_ids={11}) == "operator"
    assert (
        resolve_role_for_telegram_user(
            telegram_user_id=12,
            owner_ids=set(),
            operator_ids=set(),
            allowed_ids={12},
        )
        == "owner"
    )
    assert (
        resolve_role_for_telegram_user(
            telegram_user_id=12,
            owner_ids={10},
            operator_ids={11},
            allowed_ids={12},
        )
        is None
    )
    assert resolve_role_for_telegram_user(telegram_user_id=12, owner_ids={10}, operator_ids={11}) is None


def test_create_app_rejects_weak_jwt_secret_in_production(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("JWT_SECRET", "change_me_for_prod")
    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="JWT_SECRET is weak"):
        create_app()
    get_settings.cache_clear()
