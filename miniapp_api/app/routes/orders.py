"""Order routes for first Mini App iteration."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

import config as legacy_config
from miniapp_api.app.db import get_db_session
from miniapp_api.app.deps import require_roles
from miniapp_api.app.models import AppUser, MiniDocument, MiniOperation, MiniOrder, OrderStatus
from miniapp_api.app.schemas import OrderCreateRequest, OrderDTO, OrderFinalizeRequest, OrderUpdateRequest
from miniapp_api.app.services.audit import add_audit_log
from miniapp_api.app.services.order_finance import empty_order_finance, rollup_order_finance
from miniapp_api.app.services.sheets_sync import sync_sheets_background


router = APIRouter(prefix="/orders", tags=["orders"])
MONEY_EPSILON = Decimal("0.01")


async def _validate_order_access(
    *,
    db: AsyncSession,
    order_id: int,
    user: AppUser,
    for_update: bool = False,
) -> MiniOrder:
    stmt = select(MiniOrder).where(MiniOrder.id == order_id, MiniOrder.deleted_at.is_(None))
    if for_update:
        stmt = stmt.with_for_update()
    row = await db.execute(stmt)
    order = row.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")
    return order


def _round_money(value: float | int | Decimal | None) -> Decimal:
    try:
        amount = Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")
    if not amount.is_finite():
        return Decimal("0")
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _money_delta(target: float | Decimal, current: float | Decimal) -> Decimal:
    return _round_money(_round_money(target) - _round_money(current))


def _validate_prepared_to_close(finance: dict[str, float]) -> None:
    sale_amount = _round_money(finance.get("sale_amount"))
    paid_amount = _round_money(finance.get("paid_amount"))
    purchase_cost = _round_money(finance.get("purchase_cost"))
    recognized_cogs = _round_money(finance.get("recognized_cogs"))

    if sale_amount <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Order has no sale amount")
    if purchase_cost <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Order has no purchase cost")
    if paid_amount + MONEY_EPSILON < sale_amount:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Order has unpaid balance")
    if paid_amount - sale_amount > MONEY_EPSILON:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Order has overpayment")
    if abs(recognized_cogs - purchase_cost) > MONEY_EPSILON:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Order COGS is not recognized")


def _resolve_payment_fields(payload: OrderFinalizeRequest, operation_type: str) -> tuple[str | None, str | None]:
    payment_account = legacy_config.normalize_payment_account(payload.payment_account)
    if not payment_account:
        payment_account = legacy_config.default_payment_account_for_operation(operation_type)

    payment_method = str(payload.payment_method or "").strip().lower()
    if payment_method not in legacy_config.PAYMENT_METHODS:
        payment_method = legacy_config.payment_method_for_account(payment_account)
    return payment_account, payment_method


def _append_order_operation(
    db: AsyncSession,
    *,
    order_id: int,
    user_id: int,
    operation_type: str,
    description: str,
    amount: float | Decimal,
    payment_account: str | None = None,
    payment_method: str | None = None,
) -> None:
    db.add(
        MiniOperation(
            date=datetime.now().date().isoformat(),
            operation_type=operation_type,
            description=description,
            amount=_round_money(amount),
            payment_account=payment_account,
            payment_method=payment_method,
            income_channel="Онлайн" if operation_type in {"продажа", "корректировка продажи", "предоплата", "постоплата", "оплата"} else None,
            sale_type="Сборка",
            order_id=order_id,
            created_by_user_id=user_id,
        )
    )


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
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OrderDTO:
    """Updates basic order identity fields."""

    order = await _validate_order_access(db=db, order_id=order_id, user=current_user, for_update=True)
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
        background_tasks.add_task(sync_sheets_background)

    finance_map = await _load_finance_map(db, order_ids=[int(order.id)])
    meta_map = await _load_order_meta(db, order_ids=[int(order.id)])
    return _to_dto(order, finance_map, meta_map)


@router.post("/{order_id}/finalize", response_model=OrderDTO)
async def finalize_order(
    order_id: int,
    payload: OrderFinalizeRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OrderDTO:
    """Atomically applies sale/payment/COGS deltas and closes fully paid orders."""

    order = await _validate_order_access(db=db, order_id=order_id, user=current_user, for_update=True)
    finance_map = await _load_finance_map(db, order_ids=[int(order.id)])
    finance = finance_map.get(int(order.id), empty_order_finance())

    sale_amount = _round_money(payload.sale_amount)
    prepayment_amount = _round_money(payload.prepayment_amount)
    postpayment_amount = _round_money(payload.postpayment_amount)
    purchase_cost = _round_money(finance.get("purchase_cost"))
    recorded_sale_amount = _round_money(finance.get("sale_amount"))
    recorded_prepayment = _round_money(finance.get("prepayment_amount"))
    recorded_postpayment = _round_money(finance.get("postpayment_amount"))
    recorded_payment_receipt = _round_money(finance.get("payment_receipt_amount"))
    recorded_cogs = _round_money(finance.get("recognized_cogs"))

    if str(order.status or "").strip().lower() == "closed":
        _validate_prepared_to_close(finance)
        if abs(recorded_sale_amount - sale_amount) > MONEY_EPSILON:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Order is already closed with a different sale amount; reopen it first",
            )
        meta_map = await _load_order_meta(db, order_ids=[int(order.id)])
        return _to_dto(order, finance_map, meta_map)

    if purchase_cost <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Add order components before finalizing")

    split_income_mode = (
        bool(payload.use_split_payments)
        or prepayment_amount > 0
        or postpayment_amount > 0
        or recorded_prepayment > 0
        or recorded_postpayment > 0
    )
    planned_paid_amount = prepayment_amount + postpayment_amount if split_income_mode else sale_amount

    if split_income_mode:
        if planned_paid_amount <= 0:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Payment amount is required")
        if prepayment_amount + MONEY_EPSILON < recorded_prepayment or postpayment_amount + MONEY_EPSILON < recorded_postpayment:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Payment cannot be lower than recorded amount")
        if planned_paid_amount - sale_amount > MONEY_EPSILON:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Payments cannot exceed sale amount")
    elif sale_amount + MONEY_EPSILON < recorded_payment_receipt:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Payment cannot be lower than recorded amount")

    should_close_order = not split_income_mode or abs(planned_paid_amount - sale_amount) <= MONEY_EPSILON
    has_existing_sale = recorded_sale_amount > 0
    change_prefix = "Изменение: " if has_existing_sale else ""

    sale_delta = _money_delta(sale_amount, recorded_sale_amount)
    if abs(sale_delta) > MONEY_EPSILON:
        _append_order_operation(
            db,
            order_id=int(order.id),
            user_id=current_user.id,
            operation_type="корректировка продажи" if has_existing_sale else "продажа",
            description=f"{change_prefix}Продажа по заказу",
            amount=sale_delta,
            payment_account=legacy_config.default_payment_account_for_operation("продажа"),
            payment_method=legacy_config.payment_method_for_account(
                legacy_config.default_payment_account_for_operation("продажа")
            ),
        )

    if split_income_mode:
        payment_account, payment_method = _resolve_payment_fields(payload, "предоплата")
        prepayment_delta = _money_delta(prepayment_amount, recorded_prepayment)
        postpayment_delta = _money_delta(postpayment_amount, recorded_postpayment)
        if prepayment_delta > MONEY_EPSILON:
            _append_order_operation(
                db,
                order_id=int(order.id),
                user_id=current_user.id,
                operation_type="предоплата",
                description=f"{change_prefix}Предоплата по заказу",
                amount=prepayment_delta,
                payment_account=payment_account,
                payment_method=payment_method,
            )
        if postpayment_delta > MONEY_EPSILON:
            _append_order_operation(
                db,
                order_id=int(order.id),
                user_id=current_user.id,
                operation_type="постоплата",
                description=f"{change_prefix}Постоплата по заказу",
                amount=postpayment_delta,
                payment_account=payment_account,
                payment_method=payment_method,
            )
    else:
        payment_account, payment_method = _resolve_payment_fields(payload, "оплата")
        payment_delta = _money_delta(sale_amount, recorded_payment_receipt)
        if payment_delta > MONEY_EPSILON:
            _append_order_operation(
                db,
                order_id=int(order.id),
                user_id=current_user.id,
                operation_type="оплата",
                description=f"{change_prefix}Продажа по заказу",
                amount=payment_delta,
                payment_account=payment_account,
                payment_method=payment_method,
            )

    if should_close_order:
        cogs_delta = _money_delta(purchase_cost, recorded_cogs)
        if abs(cogs_delta) > MONEY_EPSILON:
            _append_order_operation(
                db,
                order_id=int(order.id),
                user_id=current_user.id,
                operation_type="себестоимость",
                description=f"{change_prefix}Комплектующие",
                amount=cogs_delta,
            )
        order.status = OrderStatus.CLOSED

    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="order_finalized",
        entity_type="order",
        entity_id=order.id,
        details={
            "sale_amount": float(sale_amount),
            "planned_paid_amount": float(_round_money(planned_paid_amount)),
            "purchase_cost": float(purchase_cost),
            "closed": should_close_order,
        },
    )
    await db.commit()
    background_tasks.add_task(sync_sheets_background)
    await db.refresh(order)

    finance_map = await _load_finance_map(db, order_ids=[int(order.id)])
    meta_map = await _load_order_meta(db, order_ids=[int(order.id)])
    return _to_dto(order, finance_map, meta_map)


@router.post("/{order_id}/close", response_model=OrderDTO)
async def close_order(
    order_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OrderDTO:
    """Closes an open order."""

    order = await _validate_order_access(db=db, order_id=order_id, user=current_user, for_update=True)
    finance_map = await _load_finance_map(db, order_ids=[int(order.id)])
    _validate_prepared_to_close(finance_map.get(int(order.id), empty_order_finance()))

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
    background_tasks.add_task(sync_sheets_background)
    await db.refresh(order)
    meta_map = await _load_order_meta(db, order_ids=[int(order.id)])
    return _to_dto(order, finance_map, meta_map)


@router.post("/{order_id}/reopen", response_model=OrderDTO)
async def reopen_order(
    order_id: int,
    background_tasks: BackgroundTasks,
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
    background_tasks.add_task(sync_sheets_background)
    await db.refresh(order)
    finance_map = await _load_finance_map(db, order_ids=[int(order.id)])
    meta_map = await _load_order_meta(db, order_ids=[int(order.id)])
    return _to_dto(order, finance_map, meta_map)


@router.delete("/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_order(
    order_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
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
    background_tasks.add_task(sync_sheets_background)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
