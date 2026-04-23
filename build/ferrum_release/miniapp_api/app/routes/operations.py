"""Operation routes with hybrid input mode."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from bot.services.ai_parser import parse_operation
from miniapp_api.app.db import get_db_session
from miniapp_api.app.deps import require_roles
from miniapp_api.app.models import AppUser, MiniOperation, MiniOrder
from miniapp_api.app.schemas import (
    OperationDTO,
    OperationManualCreateRequest,
    OperationManualPreviewRequest,
    OperationPreviewResponse,
    OperationTextCreateRequest,
)
from miniapp_api.app.services.audit import add_audit_log
from miniapp_api.app.services.operations import normalize_operation_payload, validate_operation_payload


router = APIRouter(prefix="/operations", tags=["operations"])


async def _validate_order_access(db: AsyncSession, *, order_id: int | None, user: AppUser) -> None:
    if order_id is None:
        return
    row = await db.execute(select(MiniOrder).where(MiniOrder.id == order_id, MiniOrder.deleted_at.is_(None)))
    order = row.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")
    if str(user.role).lower() != "owner" and int(order.opened_by_user_id) != int(user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to this order")


def _to_preview_payload(normalized: dict) -> OperationManualPreviewRequest:
    return OperationManualPreviewRequest(
        operation_type=normalized.get("operation_type"),
        description=normalized.get("description"),
        amount=normalized.get("amount"),
        date=normalized.get("date"),
        order_id=normalized.get("order_id"),
        supplier=normalized.get("supplier"),
        expense_category=normalized.get("expense_category"),
        expense_subcategory=normalized.get("expense_subcategory"),
        payment_account=normalized.get("payment_account"),
        payment_method=normalized.get("payment_method"),
        income_channel=normalized.get("income_channel"),
        sale_type=normalized.get("sale_type"),
    )


def _validation_error(missing_fields: list[str]) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail={
            "message": "Operation payload is incomplete or invalid",
            "missing_fields": missing_fields,
        },
    )


@router.get("", response_model=list[OperationDTO])
async def list_operations(
    order_id: int | None = None,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> list[OperationDTO]:
    """Returns recent operations for current user."""

    stmt = select(MiniOperation).order_by(desc(MiniOperation.id)).limit(200)
    stmt = stmt.where(MiniOperation.deleted_at.is_(None))
    if order_id is not None:
        await _validate_order_access(db, order_id=order_id, user=current_user)
        stmt = stmt.where(MiniOperation.order_id == order_id)
    elif str(current_user.role).lower() != "owner":
        stmt = stmt.where(MiniOperation.created_by_user_id == current_user.id)
    rows = await db.execute(stmt)
    return [OperationDTO.model_validate(item) for item in rows.scalars().all()]


@router.post("/preview/manual", response_model=OperationPreviewResponse)
async def preview_manual_operation(
    payload: OperationManualPreviewRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OperationPreviewResponse:
    """Normalizes operation from form fields and returns confirmation preview."""

    normalized = normalize_operation_payload(payload.model_dump())
    await _validate_order_access(db, order_id=normalized.get("order_id"), user=current_user)
    missing_fields = validate_operation_payload(normalized)
    return OperationPreviewResponse(
        operation=_to_preview_payload(normalized),
        ready_to_save=(len(missing_fields) == 0),
        missing_fields=missing_fields,
    )


@router.post("/preview/from-text", response_model=OperationPreviewResponse)
async def preview_operation_from_text(
    payload: OperationTextCreateRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OperationPreviewResponse:
    """Parses free text, normalizes fields and returns confirmation preview."""

    await _validate_order_access(db, order_id=payload.order_id, user=current_user)
    parsed = await parse_operation(payload.text.strip())
    if not parsed:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Could not parse operation from text. Add amount/type and retry.",
        )

    normalized = normalize_operation_payload(
        {**parsed, "order_id": payload.order_id},
        source_text=payload.text,
    )
    missing_fields = validate_operation_payload(normalized)
    return OperationPreviewResponse(
        operation=_to_preview_payload(normalized),
        ready_to_save=(len(missing_fields) == 0),
        missing_fields=missing_fields,
    )


@router.post("/manual", response_model=OperationDTO)
async def create_manual_operation(
    payload: OperationManualCreateRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OperationDTO:
    """Creates operation from manual form fields."""

    normalized = normalize_operation_payload(payload.model_dump())
    missing_fields = validate_operation_payload(normalized)
    if missing_fields:
        raise _validation_error(missing_fields)

    await _validate_order_access(db, order_id=normalized.get("order_id"), user=current_user)
    operation = MiniOperation(
        date=str(normalized["date"]),
        operation_type=str(normalized["operation_type"]),
        description=str(normalized["description"]),
        amount=float(normalized["amount"]),
        supplier=normalized.get("supplier"),
        expense_category=normalized.get("expense_category"),
        expense_subcategory=normalized.get("expense_subcategory"),
        payment_account=normalized.get("payment_account"),
        payment_method=normalized.get("payment_method"),
        income_channel=normalized.get("income_channel"),
        sale_type=normalized.get("sale_type"),
        order_id=normalized.get("order_id"),
        created_by_user_id=current_user.id,
    )
    db.add(operation)
    await db.commit()
    await db.refresh(operation)
    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="operation_created",
        entity_type="operation",
        entity_id=operation.id,
        details={
            "operation_type": operation.operation_type,
            "amount": operation.amount,
            "order_id": operation.order_id,
        },
    )
    await db.commit()
    return OperationDTO.model_validate(operation)


@router.post("/from-text", response_model=OperationDTO)
async def create_operation_from_text(
    payload: OperationTextCreateRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OperationDTO:
    """Parses operation from free text and stores normalized record."""

    await _validate_order_access(db, order_id=payload.order_id, user=current_user)
    parsed = await parse_operation(payload.text.strip())
    if not parsed:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Could not parse operation from text. Add amount/type and retry.",
        )

    normalized = normalize_operation_payload(
        {**parsed, "order_id": payload.order_id},
        source_text=payload.text,
    )
    missing_fields = validate_operation_payload(normalized)
    if missing_fields:
        raise _validation_error(missing_fields)

    operation = MiniOperation(
        date=str(normalized["date"]),
        operation_type=str(normalized["operation_type"]),
        description=str(normalized["description"]),
        amount=float(normalized["amount"]),
        supplier=normalized.get("supplier"),
        expense_category=normalized.get("expense_category"),
        expense_subcategory=normalized.get("expense_subcategory"),
        payment_account=normalized.get("payment_account"),
        payment_method=normalized.get("payment_method"),
        income_channel=normalized.get("income_channel"),
        sale_type=normalized.get("sale_type"),
        order_id=normalized.get("order_id"),
        created_by_user_id=current_user.id,
    )
    db.add(operation)
    await db.commit()
    await db.refresh(operation)
    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="operation_created",
        entity_type="operation",
        entity_id=operation.id,
        details={
            "operation_type": operation.operation_type,
            "amount": operation.amount,
            "order_id": operation.order_id,
            "source": "text",
        },
    )
    await db.commit()
    return OperationDTO.model_validate(operation)


@router.put("/{operation_id}", response_model=OperationDTO)
async def update_operation(
    operation_id: int,
    payload: OperationManualCreateRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OperationDTO:
    """Updates an existing operation."""

    row = await db.execute(select(MiniOperation).where(MiniOperation.id == operation_id, MiniOperation.deleted_at.is_(None)))
    operation = row.scalar_one_or_none()
    if not operation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operation not found")

    if str(current_user.role).lower() != "owner":
        if operation.order_id is not None:
            await _validate_order_access(db, order_id=int(operation.order_id), user=current_user)
        elif int(operation.created_by_user_id) != int(current_user.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to this operation")

    normalized = normalize_operation_payload(payload.model_dump())
    missing_fields = validate_operation_payload(normalized)
    if missing_fields:
        raise _validation_error(missing_fields)

    await _validate_order_access(db, order_id=normalized.get("order_id"), user=current_user)

    before = {
        "date": operation.date,
        "operation_type": operation.operation_type,
        "description": operation.description,
        "amount": operation.amount,
        "order_id": operation.order_id,
    }

    operation.date = str(normalized["date"])
    operation.operation_type = str(normalized["operation_type"])
    operation.description = str(normalized["description"])
    operation.amount = float(normalized["amount"])
    operation.supplier = normalized.get("supplier")
    operation.expense_category = normalized.get("expense_category")
    operation.expense_subcategory = normalized.get("expense_subcategory")
    operation.payment_account = normalized.get("payment_account")
    operation.payment_method = normalized.get("payment_method")
    operation.income_channel = normalized.get("income_channel")
    operation.sale_type = normalized.get("sale_type")
    operation.order_id = normalized.get("order_id")

    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="operation_updated",
        entity_type="operation",
        entity_id=operation.id,
        details={
            "before": before,
            "after": {
                "date": operation.date,
                "operation_type": operation.operation_type,
                "description": operation.description,
                "amount": operation.amount,
                "order_id": operation.order_id,
            },
        },
    )
    await db.commit()
    await db.refresh(operation)
    return OperationDTO.model_validate(operation)


@router.delete("/{operation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_operation(
    operation_id: int,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> Response:
    """Soft-deletes operation visible to current user."""

    row = await db.execute(select(MiniOperation).where(MiniOperation.id == operation_id, MiniOperation.deleted_at.is_(None)))
    operation = row.scalar_one_or_none()
    if not operation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operation not found")

    if str(current_user.role).lower() != "owner":
        if operation.order_id is not None:
            await _validate_order_access(db, order_id=int(operation.order_id), user=current_user)
        elif int(operation.created_by_user_id) != int(current_user.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to this operation")

    operation.deleted_at = datetime.now()
    operation.deleted_by_user_id = current_user.id
    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="operation_deleted",
        entity_type="operation",
        entity_id=operation.id,
        details={
            "operation_type": operation.operation_type,
            "amount": operation.amount,
            "order_id": operation.order_id,
        },
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
