"""Owner-only administrative routes for Mini App."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from miniapp_api.app.db import get_db_session
from miniapp_api.app.deps import require_roles
from miniapp_api.app.models import AppUser
from miniapp_api.app.schemas import AiModelStateResponse, AiModelUpdateRequest, GoogleSheetsSyncResponse
from miniapp_api.app.services.audit import add_audit_log
from miniapp_api.app.services.google_sheets import sync_google_sheets_from_miniapp
from bot.services.ai_runtime import get_available_ai_models, read_ai_runtime_state, set_active_ai_model


router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/ai-model", response_model=AiModelStateResponse)
async def get_ai_model_state(
    current_user: AppUser = Depends(require_roles("owner")),
) -> AiModelStateResponse:
    """Returns owner-visible runtime AI model state."""

    state = read_ai_runtime_state()
    return AiModelStateResponse(
        active_model=str(state.get("active_model") or ""),
        updated_at=state.get("updated_at"),
        available_models=get_available_ai_models(),
    )


@router.post("/ai-model", response_model=AiModelStateResponse)
async def update_ai_model_state(
    payload: AiModelUpdateRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner")),
) -> AiModelStateResponse:
    """Persists runtime AI model switch without restarting services."""

    try:
        state = set_active_ai_model(payload.model)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="ai_model_switched",
        entity_type="admin",
        details={"active_model": state.get("active_model")},
    )
    await db.commit()
    return AiModelStateResponse(
        active_model=str(state.get("active_model") or ""),
        updated_at=state.get("updated_at"),
        available_models=get_available_ai_models(),
    )


@router.post("/google-sheets/sync", response_model=GoogleSheetsSyncResponse)
async def sync_google_sheets(
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner")),
) -> GoogleSheetsSyncResponse:
    """Runs a full Google Sheets sync from current Mini App data."""

    try:
        result = await sync_google_sheets_from_miniapp(db)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google Sheets credentials file is missing",
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Google Sheets sync failed: {exc}",
        ) from exc

    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="google_sheets_synced",
        entity_type="admin",
        details={
            "spreadsheet_id": result.get("spreadsheet_id"),
            "operations_exported": result.get("operations_exported"),
            "review_items": result.get("review_items"),
        },
    )
    await db.commit()
    return GoogleSheetsSyncResponse(**result)
