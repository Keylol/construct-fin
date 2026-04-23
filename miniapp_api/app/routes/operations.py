"""Operation routes with hybrid input mode."""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

import config as legacy_config
from bot.services.ai_parser import parse_operation
from miniapp_api.app.config import get_settings
from miniapp_api.app.db import get_db_session, get_session_factory
from miniapp_api.app.deps import require_roles
from miniapp_api.app.models import AppUser, MiniDocument, MiniOperation, MiniOrder
from miniapp_api.app.schemas import (
    DocumentDTO,
    OperationDTO,
    OperationManualCreateRequest,
    OperationManualPreviewRequest,
    OperationPreviewResponse,
    OperationTextCreateRequest,
)
from miniapp_api.app.services.audit import add_audit_log
from miniapp_api.app.services.google_sheets import sync_google_sheets_from_miniapp
from miniapp_api.app.services.operations import normalize_operation_payload, validate_operation_payload

logger = logging.getLogger(__name__)


async def _sync_sheets_background() -> None:
    """Fire-and-forget Google Sheets sync after any operation mutation."""
    try:
        session_factory = get_session_factory()
        async with session_factory() as db:
            await sync_google_sheets_from_miniapp(db)
    except Exception:
        logger.exception("Google Sheets background sync failed")


router = APIRouter(prefix="/operations", tags=["operations"])


def _unique_path(path: Path) -> Path:
    candidate = path
    counter = 1
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}_{counter}{path.suffix}")
        counter += 1
    return candidate


async def _load_operation_with_access(
    *, db: AsyncSession, operation_id: int, user: AppUser
) -> MiniOperation:
    row = await db.execute(
        select(MiniOperation).where(
            MiniOperation.id == operation_id, MiniOperation.deleted_at.is_(None)
        )
    )
    operation = row.scalar_one_or_none()
    if not operation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operation not found")
    return operation


async def _latest_receipt_for_operation(
    *, db: AsyncSession, operation_id: int
) -> MiniDocument | None:
    row = await db.execute(
        select(MiniDocument)
        .where(
            MiniDocument.operation_id == operation_id,
            MiniDocument.doc_kind == "receipt",
            MiniDocument.deleted_at.is_(None),
        )
        .order_by(desc(MiniDocument.id))
        .limit(1)
    )
    return row.scalar_one_or_none()


async def _decorate_operation_dto(
    *, db: AsyncSession, operation: MiniOperation
) -> OperationDTO:
    dto = OperationDTO.model_validate(operation)
    receipt = await _latest_receipt_for_operation(db=db, operation_id=int(operation.id))
    if receipt is not None:
        dto.has_receipt = True
        dto.receipt_document_id = int(receipt.id)
    return dto


async def _decorate_operation_list(
    *, db: AsyncSession, operations: list[MiniOperation]
) -> list[OperationDTO]:
    if not operations:
        return []
    ids = [int(op.id) for op in operations]
    rows = await db.execute(
        select(MiniDocument.operation_id, MiniDocument.id)
        .where(
            MiniDocument.operation_id.in_(ids),
            MiniDocument.doc_kind == "receipt",
            MiniDocument.deleted_at.is_(None),
        )
        .order_by(desc(MiniDocument.id))
    )
    receipt_by_op: dict[int, int] = {}
    for op_id, doc_id in rows.all():
        if op_id is None:
            continue
        # Keep the first (= latest due to desc order) per operation.
        receipt_by_op.setdefault(int(op_id), int(doc_id))
    result: list[OperationDTO] = []
    for operation in operations:
        dto = OperationDTO.model_validate(operation)
        doc_id = receipt_by_op.get(int(operation.id))
        if doc_id is not None:
            dto.has_receipt = True
            dto.receipt_document_id = doc_id
        result.append(dto)
    return result


async def _validate_order_access(db: AsyncSession, *, order_id: int | None, user: AppUser) -> None:
    if order_id is None:
        return
    row = await db.execute(select(MiniOrder).where(MiniOrder.id == order_id, MiniOrder.deleted_at.is_(None)))
    order = row.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")


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
    rows = await db.execute(stmt)
    operations = list(rows.scalars().all())
    return await _decorate_operation_list(db=db, operations=operations)


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
    background_tasks: BackgroundTasks,
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
    background_tasks.add_task(_sync_sheets_background)
    return await _decorate_operation_dto(db=db, operation=operation)


@router.post("/from-text", response_model=OperationDTO)
async def create_operation_from_text(
    payload: OperationTextCreateRequest,
    background_tasks: BackgroundTasks,
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
    background_tasks.add_task(_sync_sheets_background)
    return await _decorate_operation_dto(db=db, operation=operation)


@router.put("/{operation_id}", response_model=OperationDTO)
async def update_operation(
    operation_id: int,
    payload: OperationManualCreateRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> OperationDTO:
    """Updates an existing operation."""

    row = await db.execute(select(MiniOperation).where(MiniOperation.id == operation_id, MiniOperation.deleted_at.is_(None)))
    operation = row.scalar_one_or_none()
    if not operation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operation not found")

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
    background_tasks.add_task(_sync_sheets_background)
    return await _decorate_operation_dto(db=db, operation=operation)


@router.delete("/{operation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_operation(
    operation_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> Response:
    """Soft-deletes operation visible to current user."""

    row = await db.execute(select(MiniOperation).where(MiniOperation.id == operation_id, MiniOperation.deleted_at.is_(None)))
    operation = row.scalar_one_or_none()
    if not operation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operation not found")

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
    background_tasks.add_task(_sync_sheets_background)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{operation_id}/receipt", response_model=DocumentDTO)
async def upload_operation_receipt(
    operation_id: int,
    file: UploadFile = File(...),
    doc_type: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> DocumentDTO:
    """Attach a receipt file (image or PDF) to an existing operation."""

    operation = await _load_operation_with_access(
        db=db, operation_id=operation_id, user=current_user
    )

    original_name = Path(file.filename or "receipt").name
    extension = Path(original_name).suffix.lower()
    if extension not in legacy_config.SUPPORTED_RECEIPT_EXTENSIONS:
        allowed = ", ".join(sorted(legacy_config.SUPPORTED_RECEIPT_EXTENSIONS))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unsupported receipt extension. Allowed: {allowed}",
        )

    settings = get_settings()
    target_dir = (
        Path(settings.miniapp_documents_dir).resolve() / f"operation_{int(operation.id)}"
    )
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = _unique_path(target_dir / original_name)
    max_bytes = max(int(settings.miniapp_max_upload_mb), 1) * 1024 * 1024

    hasher = hashlib.sha256()
    bytes_written = 0
    with open(target_path, "wb") as file_obj:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            bytes_written += len(chunk)
            if bytes_written > max_bytes:
                file_obj.close()
                target_path.unlink(missing_ok=True)
                await file.close()
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail=f"File is too large (max {settings.miniapp_max_upload_mb} MB)",
                )
            hasher.update(chunk)
            file_obj.write(chunk)
    await file.close()
    file_hash = hasher.hexdigest()

    # Dedupe: same hash for the same operation? Return existing record, drop the fresh file.
    existing_row = await db.execute(
        select(MiniDocument).where(
            MiniDocument.operation_id == int(operation.id),
            MiniDocument.file_hash == file_hash,
            MiniDocument.deleted_at.is_(None),
        )
    )
    existing = existing_row.scalar_one_or_none()
    if existing is not None:
        target_path.unlink(missing_ok=True)
        return DocumentDTO.model_validate(existing)

    normalized_doc_type = (doc_type or "чек").strip().lower() or "чек"
    document = MiniDocument(
        order_id=operation.order_id,
        operation_id=int(operation.id),
        doc_kind="receipt",
        doc_type=normalized_doc_type,
        file_name=target_path.name,
        file_path=str(target_path),
        file_hash=file_hash,
        uploaded_by_user_id=current_user.id,
    )
    db.add(document)
    await db.commit()
    await db.refresh(document)
    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="operation_receipt_uploaded",
        entity_type="operation",
        entity_id=int(operation.id),
        details={
            "document_id": int(document.id),
            "file_name": document.file_name,
        },
    )
    await db.commit()
    return DocumentDTO.model_validate(document)


@router.get("/{operation_id}/receipt")
async def download_operation_receipt(
    operation_id: int,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> FileResponse:
    """Download the latest receipt file for an operation."""

    operation = await _load_operation_with_access(
        db=db, operation_id=operation_id, user=current_user
    )
    receipt = await _latest_receipt_for_operation(db=db, operation_id=int(operation.id))
    if receipt is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receipt not found")
    file_path = Path(str(receipt.file_path or "")).resolve()
    if not file_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Receipt file is missing on disk"
        )
    return FileResponse(path=file_path, filename=receipt.file_name)


@router.delete("/{operation_id}/receipt", status_code=status.HTTP_204_NO_CONTENT)
async def delete_operation_receipt(
    operation_id: int,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> Response:
    """Soft-delete the latest receipt attached to an operation."""

    operation = await _load_operation_with_access(
        db=db, operation_id=operation_id, user=current_user
    )
    receipt = await _latest_receipt_for_operation(db=db, operation_id=int(operation.id))
    if receipt is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receipt not found")
    receipt.deleted_at = datetime.now()
    receipt.deleted_by_user_id = current_user.id
    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="operation_receipt_deleted",
        entity_type="operation",
        entity_id=int(operation.id),
        details={"document_id": int(receipt.id)},
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
