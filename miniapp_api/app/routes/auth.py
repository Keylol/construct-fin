"""Auth routes for Telegram Mini App."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from miniapp_api.app.config import get_settings
from miniapp_api.app.db import get_db_session
from miniapp_api.app.deps import get_current_user, resolve_role_for_telegram_user
from miniapp_api.app.models import AppUser, UserRole
from miniapp_api.app.schemas import TelegramAuthRequest, TelegramAuthResponse, UserDTO
from miniapp_api.app.security.telegram import TelegramInitDataError, verify_telegram_init_data
from miniapp_api.app.security.tokens import issue_access_token


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/telegram", response_model=TelegramAuthResponse)
async def auth_via_telegram(
    payload: TelegramAuthRequest,
    db: AsyncSession = Depends(get_db_session),
) -> TelegramAuthResponse:
    """Validates Telegram initData and returns API token."""

    settings = get_settings()
    try:
        parsed = verify_telegram_init_data(init_data=payload.init_data, bot_token=settings.telegram_bot_token)
    except TelegramInitDataError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    role = resolve_role_for_telegram_user(
        telegram_user_id=parsed.telegram_user_id,
        owner_ids=settings.owner_ids,
        operator_ids=settings.operator_ids,
        allowed_ids=settings.allowed_ids,
    )
    if not role:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied for this Telegram user")
    if settings.miniapp_soft_launch_owner_only and str(role).lower() != "owner":
        if parsed.telegram_user_id not in settings.soft_launch_operator_ids:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Soft launch mode: owner-only access")
    role_value = UserRole(str(role).lower())

    row = await db.execute(select(AppUser).where(AppUser.telegram_user_id == parsed.telegram_user_id))
    user = row.scalar_one_or_none()
    if user:
        user.first_name = parsed.first_name
        user.last_name = parsed.last_name
        user.username = parsed.username
        user.language_code = parsed.language_code
        user.role = role_value
    else:
        user = AppUser(
            telegram_user_id=parsed.telegram_user_id,
            first_name=parsed.first_name,
            last_name=parsed.last_name,
            username=parsed.username,
            language_code=parsed.language_code,
            role=role_value,
        )
        db.add(user)

    await db.commit()
    await db.refresh(user)

    token = issue_access_token(
        user_id=user.id,
        role=str(role_value),
        secret=settings.jwt_secret,
        ttl_seconds=settings.jwt_ttl_seconds,
    )
    return TelegramAuthResponse(access_token=token, user=UserDTO.model_validate(user))


@router.get("/me", response_model=UserDTO)
async def auth_me(current_user: AppUser = Depends(get_current_user)) -> UserDTO:
    """Returns authenticated user profile."""

    return UserDTO.model_validate(current_user)
