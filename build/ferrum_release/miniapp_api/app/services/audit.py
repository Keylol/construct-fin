"""Audit helpers for Mini App critical actions."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from miniapp_api.app.models import MiniAuditLog


async def add_audit_log(
    db: AsyncSession,
    *,
    actor_user_id: int,
    action: str,
    entity_type: str,
    entity_id: int | None = None,
    details: dict | None = None,
) -> None:
    """Appends a single audit event to the current DB session."""

    db.add(
        MiniAuditLog(
            actor_user_id=int(actor_user_id),
            action=str(action).strip(),
            entity_type=str(entity_type).strip(),
            entity_id=(int(entity_id) if entity_id is not None else None),
            details=details or None,
        )
    )
