"""Order routes for first Mini App iteration."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from miniapp_api.app.db import get_db_session
from miniapp_api.app.deps import require_roles
from miniapp_api.app.models import AppUser, MiniDocument, MiniOperation, MiniOrder, OrderStatus
from miniapp_api.app.schemas import OrderCreateRequest, OrderDTO, OrderUpdateRequest
from miniapp_api.app.services.audit import add_audit_log
from miniapp_api.app.services.order_finance import empty_order_finance, rollup_order_finance


router = APIRouter(prefix="/orders", tags=["orders"])


async def _validate_order_access(*, db: AsyncSession, order_id: int, user: AppUser) -> MiniOrder:
    row = await db.execute(select(MiniOrder).where(MiniOrder.id == order_id, MiniOrder.deleted_at.is_(None)))
    order = row.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")
    if str(user.role).lower() != "owner" and int(order.opened_by_user_id) != int(user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to this order")
    return order


async def _load_finance_map(db: AsyncSession, *, order_ids: list[int]) -> dict[int, dict[str, float]]:
    if not order_ids:
        return {}

    rows = await db.execute(
        select(MiniOperation.order_id, MiniOperation.operation_type, MiniOperation.amount).where(
            MiniOperation.order_id.in_(order_ids),
            MiniOperation.deleted_at.is_(None),
        )
    )
    operations = [
        {
            "order_id": order_id,
            "operation_type": operation_type,
            "amount": amount,
        }
        for order_id, operation_type, amount in rows.all()
    ]
    return rollup_order_finance(operations)


async def _load_order_meta(db: AsyncSession, *, order_ids: list[int]) -> dict[int, dict[str, object]]:
    if not order_ids:
        return {}

    meta_map: dict[int, dict[str, object]] = {
        int(order_id): {
            "documents_count": 0,
            "has_changes": False,
            "last_activity_at": None,
        }
        for order_id in order_ids
    }

    op_rows = await db.execute(
        select(
            MiniOperation.order_id,
            MiniOperation.operation_type,
            MiniOperation.description,
            MiniOperation.created_at,
        ).where(MiniOperation.order_id.in_(order_ids))
        .where(MiniOperation.deleted_at.is_(None))
    )
    for order_id, operation_type, description, created_at in op_rows.all():
        if order_id is None:
            continue
        key = int(order_id)
        bucket = meta_map.setdefault(
            key,
            {"documents_count": 0, "has_changes": False, "last_activity_at": None},
        )

        text = str(description or "").strip().lower()
        if str(operation_type or "").strip().lower() == "корректировка продажи" or text.startswith("изменение:") or text.startswith("change:"):
            bucket["has_changes"] = True

        last_activity = bucket.get("last_activity_at")
        if created_at and (last_activity is None or created_at > last_activity):
            bucket["last_activity_at"] = created_at

    doc_rows = await db.execute(
        select(
            MiniDocument.order_id,
            func.count(MiniDocument.id),
            func.max(MiniDocument.uploaded_at),
        )
        .where(MiniDocument.order_id.in_(order_ids), MiniDocument.deleted_at.is_(None))
        .group_by(MiniDocument.order_id)
    )
    for order_id, documents_count, last_document_at in doc_rows.all():
        if order_id is None:
            continue
        key = int(order_id)
        bucket = meta_map.setdefault(
            key,
            {"documents_count": 0, "has_changes": False, "last_activity_at": None},
        )
        bucket["documents_count"] = int(documents_count or 0)
        last_activity = bucket.get("last_activity_at")
        if last_document_at and (last_activity is None or last_document_at > last_activity):
            bucket["last_activity_at"] = last_document_at

    return meta_map


def _latest_timestamp(*values: datetime | None) -> datetime | None:
    filtered = [item for item in values if item is not None]
    if not filtered:
        return None
    return max(filtered)


def _to_dto(order: MiniOrder, finance_map: dict[int, dict[str, float]], meta_map: dict[int, dict[str, object]]) -> OrderDTO:
    finance = finance_map.get(int(order.id), empty_order_finance())
    meta = meta_map.get(int(order.id), {})
    last_activity_at = _latest_timestamp(
        order.updated_at,
        meta.get("last_activity_at") if isinstance(meta.get("last_activity_at"), datetime) else None,
    )
    return OrderDTO(
        id=order.id,
        order_phone=order.order_phone,
        client_name=order.client_name,
        status=str(order.status),
        opened_by_user_id=order.opened_by_user_id,
        sale_amount=finance["sale_amount"],
        paid_amount=finance["paid_amount"],
        prepayment_amount=finance["prepayment_amount"],
        postpayment_amount=finance["postpayment_amount"],
        payment_receipt_amount=finance["payment_receipt_amount"],
        purchase_cost=finance["purchase_cost"],
        recognized_cogs=finance["recognized_cogs"],
        balance_due=finance["balance_due"],
        documents_count=int(meta.get("documents_count") or 0),
        has_changes=bool(meta.get("has_changes") or False),
        last_activity_at=last_activity_at,
        created_at=order.created_at,
        updated_at=order.updated_at,
    )


@router.get("", response_model=list[OrderDTO])
async def list_orders(
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> list[OrderDTO]:
    """Returns recent orders visible to current user."""

    stmt = select(MiniOrder).order_by(desc(MiniOrder.id)).limit(100)
    stmt = stmt.where(MiniOrder.deleted_at.is_(None))
    if str(current_user.role).lower() != "owner":
        stmt = stmt.where(MiniOrder.opened_by_user_id == current_user.id)
    rows = await db.execute(stmt)
    orders = rows.scalars().all()
    finance_map = await _load_finance_map(db, order_ids=[int(item.id) for item in orders])
    meta_map = await _load_order_meta(db, order_ids=[int(item.id) for item in orders])
    return [_to_dto(item, finance_map, meta_map) for item in orders]


@router.post("", response_model=OrderDTO)
async def create_order(
    payload: OrderCreateRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OrderDTO:
    """Creates order card for Mini App."""

    order = MiniOrder(
        order_phone=payload.order_phone.strip(),
        client_name=(payload.client_name.strip() if payload.client_name else None),
        status=OrderStatus.OPEN,
        opened_by_user_id=current_user.id,
    )
    db.add(order)
    await db.commit()
    await db.refresh(order)
    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="order_created",
        entity_type="order",
        entity_id=order.id,
        details={
            "order_phone": order.order_phone,
            "client_name": order.client_name,
        },
    )
    await db.commit()
    return _to_dto(order, {}, {})


@router.put("/{order_id}", response_model=OrderDTO)
async def update_order(
    order_id: int,
    payload: OrderUpdateRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OrderDTO:
    """Updates basic order identity fields."""

    order = await _validate_order_access(db=db, order_id=order_id, user=current_user)
    changed_fields: dict[str, str | None] = {}

    if payload.order_phone is not None:
        next_phone = payload.order_phone.strip()
        if not next_phone:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Order phone cannot be empty")
        if next_phone != str(order.order_phone or "").strip():
            changed_fields["order_phone"] = next_phone
            order.order_phone = next_phone

    if payload.client_name is not None:
        next_name = payload.client_name.strip() or None
        if next_name != (str(order.client_name).strip() if order.client_name else None):
            changed_fields["client_name"] = next_name
            order.client_name = next_name

    if changed_fields:
        await add_audit_log(
            db,
            actor_user_id=current_user.id,
            action="order_updated",
            entity_type="order",
            entity_id=order.id,
            details=changed_fields,
        )
        await db.commit()
        await db.refresh(order)

    finance_map = await _load_finance_map(db, order_ids=[int(order.id)])
    meta_map = await _load_order_meta(db, order_ids=[int(order.id)])
    return _to_dto(order, finance_map, meta_map)


@router.post("/{order_id}/close", response_model=OrderDTO)
async def close_order(
    order_id: int,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OrderDTO:
    """Closes an open order."""

    order = await _validate_order_access(db=db, order_id=order_id, user=current_user)

    order.status = OrderStatus.CLOSED
    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="order_closed",
        entity_type="order",
        entity_id=order.id,
        details={"status": "closed"},
    )
    await db.commit()
    await db.refresh(order)
    finance_map = await _load_finance_map(db, order_ids=[int(order.id)])
    meta_map = await _load_order_meta(db, order_ids=[int(order.id)])
    return _to_dto(order, finance_map, meta_map)


@router.post("/{order_id}/reopen", response_model=OrderDTO)
async def reopen_order(
    order_id: int,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OrderDTO:
    """Re-opens a previously closed order."""

    order = await _validate_order_access(db=db, order_id=order_id, user=current_user)

    order.status = OrderStatus.OPEN
    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="order_reopened",
        entity_type="order",
        entity_id=order.id,
        details={"status": "open"},
    )
    await db.commit()
    await db.refresh(order)
    finance_map = await _load_finance_map(db, order_ids=[int(order.id)])
    meta_map = await _load_order_meta(db, order_ids=[int(order.id)])
    return _to_dto(order, finance_map, meta_map)


@router.delete("/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_order(
    order_id: int,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner")),
) -> Response:
    """Soft-deletes order with linked operations and documents."""

    order = await _validate_order_access(db=db, order_id=order_id, user=current_user)
    deleted_at = datetime.now()

    doc_rows = await db.execute(
        select(MiniDocument).where(MiniDocument.order_id == order_id, MiniDocument.deleted_at.is_(None))
    )
    documents = doc_rows.scalars().all()
    op_rows = await db.execute(
        select(MiniOperation).where(MiniOperation.order_id == order_id, MiniOperation.deleted_at.is_(None))
    )
    operations = op_rows.scalars().all()

    for document in documents:
        document.deleted_at = deleted_at
        document.deleted_by_user_id = current_user.id
    for operation in operations:
        operation.deleted_at = deleted_at
        operation.deleted_by_user_id = current_user.id
    order.deleted_at = deleted_at
    order.deleted_by_user_id = current_user.id

    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="order_deleted",
        entity_type="order",
        entity_id=order.id,
        details={
            "linked_operations": len(operations),
            "linked_documents": len(documents),
        },
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
