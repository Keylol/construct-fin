"""JWT token helpers."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import jwt


def issue_access_token(*, user_id: int, role: str, secret: str, ttl_seconds: int) -> str:
    """Issues signed JWT for API access."""

    now = datetime.now(tz=UTC)
    payload = {
        "sub": str(user_id),
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_access_token(*, token: str, secret: str) -> dict:
    """Decodes and validates JWT access token."""

    return jwt.decode(token, secret, algorithms=["HS256"])
