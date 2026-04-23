"""Audit log routes for Mini App administration."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from miniapp_api.app.db import get_db_session
from miniapp_api.app.deps import require_roles
from miniapp_api.app.models import AppUser, MiniAuditLog
from miniapp_api.app.schemas import AuditLogDTO


router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("/logs", response_model=list[AuditLogDTO])
async def list_audit_logs(
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner")),
) -> list[AuditLogDTO]:
    """Returns recent audit records for owners."""

    rows = await db.execute(select(MiniAuditLog).order_by(desc(MiniAuditLog.id)).limit(limit))
    return [AuditLogDTO.model_validate(item) for item in rows.scalars().all()]
