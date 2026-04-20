"""FastAPI dependencies for auth and role checks."""

from __future__ import annotations

from typing import Iterable

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from miniapp_api.app.config import get_settings
from miniapp_api.app.db import get_db_session
from miniapp_api.app.models import AppUser
from miniapp_api.app.security.tokens import decode_access_token


bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db_session),
) -> AppUser:
    """Gets currently authenticated user from Bearer JWT."""

    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")

    settings = get_settings()
    try:
        payload = decode_access_token(token=credentials.credentials, secret=settings.jwt_secret)
        user_id = int(payload.get("sub"))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from exc

    row = await db.execute(select(AppUser).where(AppUser.id == user_id))
    user = row.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def require_roles(*roles: str):
    """Dependency factory checking if user has one of requested roles."""

    normalized = {str(role).strip().lower() for role in roles}

    async def _guard(user: AppUser = Depends(get_current_user)) -> AppUser:
        if str(user.role).strip().lower() not in normalized:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role")
        return user

    return _guard


def resolve_role_for_telegram_user(
    *,
    telegram_user_id: int,
    owner_ids: Iterable[int],
    operator_ids: Iterable[int],
    allowed_ids: Iterable[int] | None = None,
) -> str | None:
    """Maps Telegram user id to one of allowed roles."""

    user_id = int(telegram_user_id)
    owner_id_set = set(owner_ids)
    operator_id_set = set(operator_ids)
    legacy_allowed_id_set = set(allowed_ids or [])

    if user_id in owner_id_set:
        return "owner"
    if user_id in operator_id_set:
        return "operator"

    # Backward compatibility for legacy single-user setups: if explicit Mini App
    # roles are not configured yet, allow the old bot allow-list to act as owner.
    if not owner_id_set and not operator_id_set and user_id in legacy_allowed_id_set:
        return "owner"
    return None
