"""Document upload/list routes for Mini App."""

from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

import config as legacy_config
from miniapp_api.app.config import get_settings
from miniapp_api.app.db import get_db_session
from miniapp_api.app.deps import require_roles
from miniapp_api.app.models import AppUser, MiniDocument, MiniOperation, MiniOrder
from miniapp_api.app.schemas import DocumentAssistResponse, DocumentDTO
from miniapp_api.app.services.audit import add_audit_log
from miniapp_api.app.services.document_assist import build_document_assist_payload
from miniapp_api.app.services.order_finance import empty_order_finance, rollup_order_finance


router = APIRouter(prefix="/documents", tags=["documents"])


def _normalize_doc_type(raw_type: str | None, *, extension: str) -> str:
    value = str(raw_type or "").strip().lower()
    if value in legacy_config.DOCUMENT_TYPES:
        return value
    if extension == ".pdf":
        return "чек"
    return "другое"


def _unique_path(path: Path) -> Path:
    candidate = path
    counter = 1
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}_{counter}{path.suffix}")
        counter += 1
    return candidate


async def _validate_order_access(*, db: AsyncSession, order_id: int, user: AppUser) -> MiniOrder:
    row = await db.execute(select(MiniOrder).where(MiniOrder.id == order_id, MiniOrder.deleted_at.is_(None)))
    order = row.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")
    if str(user.role).lower() != "owner" and int(order.opened_by_user_id) != int(user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to this order")
    return order


async def _load_document_with_access(*, db: AsyncSession, document_id: int, user: AppUser) -> MiniDocument:
    row = await db.execute(select(MiniDocument).where(MiniDocument.id == document_id, MiniDocument.deleted_at.is_(None)))
    document = row.scalar_one_or_none()
    if not document:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    await _validate_order_access(db=db, order_id=int(document.order_id), user=user)
    return document


async def _load_order_finance(*, db: AsyncSession, order_id: int) -> dict[str, float]:
    rows = await db.execute(
        select(MiniOperation.order_id, MiniOperation.operation_type, MiniOperation.amount).where(
            MiniOperation.order_id == order_id,
            MiniOperation.deleted_at.is_(None),
        )
    )
    finance_map = rollup_order_finance(
        [
            {
                "order_id": item_order_id,
                "operation_type": operation_type,
                "amount": amount,
            }
            for item_order_id, operation_type, amount in rows.all()
        ]
    )
    return finance_map.get(int(order_id), empty_order_finance())


@router.get("", response_model=list[DocumentDTO])
async def list_documents(
    order_id: int | None = None,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> list[DocumentDTO]:
    """Returns documents, filtered by order or role scope."""

    stmt = select(MiniDocument).order_by(desc(MiniDocument.id)).limit(300)
    stmt = stmt.where(MiniDocument.deleted_at.is_(None))
    if order_id is not None:
        await _validate_order_access(db=db, order_id=order_id, user=current_user)
        stmt = stmt.where(MiniDocument.order_id == order_id)
    elif str(current_user.role).lower() != "owner":
        allowed_order_ids_subquery = select(MiniOrder.id).where(
            MiniOrder.opened_by_user_id == current_user.id,
            MiniOrder.deleted_at.is_(None),
        )
        stmt = stmt.where(MiniDocument.order_id.in_(allowed_order_ids_subquery))

    rows = await db.execute(stmt)
    return [DocumentDTO.model_validate(item) for item in rows.scalars().all()]


def _document_archive_name(document: MiniDocument) -> str:
    order_prefix = f"order_{int(document.order_id)}"
    return f"{order_prefix}/{int(document.id)}_{document.file_name}"


@router.post("", response_model=DocumentDTO)
async def upload_document(
    order_id: int = Form(...),
    file: UploadFile = File(...),
    doc_type: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> DocumentDTO:
    """Uploads file and binds it to order."""

    await _validate_order_access(db=db, order_id=order_id, user=current_user)

    original_name = Path(file.filename or "document").name
    extension = Path(original_name).suffix.lower()
    if extension not in legacy_config.SUPPORTED_DOCUMENT_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Unsupported extension. Allowed: pdf, doc, docx",
        )

    settings = get_settings()
    target_dir = Path(settings.miniapp_documents_dir).resolve() / f"order_{order_id}"
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

    duplicate_row = await db.execute(
        select(MiniDocument).where(
            MiniDocument.order_id == order_id,
            MiniDocument.file_hash == file_hash,
            MiniDocument.deleted_at.is_(None),
        )
    )
    duplicate = duplicate_row.scalar_one_or_none()
    if duplicate:
        target_path.unlink(missing_ok=True)
        return DocumentDTO.model_validate(duplicate)

    document = MiniDocument(
        order_id=order_id,
        doc_type=_normalize_doc_type(doc_type, extension=extension),
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
        action="document_uploaded",
        entity_type="document",
        entity_id=document.id,
        details={
            "order_id": document.order_id,
            "doc_type": document.doc_type,
            "file_name": document.file_name,
        },
    )
    await db.commit()
    return DocumentDTO.model_validate(document)


@router.get("/export/all")
async def export_all_documents(
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> StreamingResponse:
    """Downloads all visible documents in a single zip archive."""

    stmt = select(MiniDocument).where(MiniDocument.deleted_at.is_(None)).order_by(desc(MiniDocument.order_id), desc(MiniDocument.id))
    if str(current_user.role).lower() != "owner":
        allowed_order_ids_subquery = select(MiniOrder.id).where(
            MiniOrder.opened_by_user_id == current_user.id,
            MiniOrder.deleted_at.is_(None),
        )
        stmt = stmt.where(MiniDocument.order_id.in_(allowed_order_ids_subquery))

    rows = await db.execute(stmt)
    documents = rows.scalars().all()
    if not documents:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No documents available for export")

    buffer = BytesIO()
    exported_files = 0
    with ZipFile(buffer, mode="w", compression=ZIP_DEFLATED) as archive:
        for document in documents:
            file_path = Path(str(document.file_path or "")).resolve()
            if not file_path.exists():
                continue
            archive.write(file_path, arcname=_document_archive_name(document))
            exported_files += 1

    if exported_files == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document files not found on disk")

    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="documents_exported",
        entity_type="document",
        details={"scope": "all", "files_count": exported_files},
    )
    await db.commit()

    buffer.seek(0)
    filename = "constructpc_documents_export.zip"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(buffer, media_type="application/zip", headers=headers)


@router.get("/{document_id}/download")
async def download_document(
    document_id: int,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> FileResponse:
    """Downloads a single document visible to the current user."""

    document = await _load_document_with_access(db=db, document_id=document_id, user=current_user)
    file_path = Path(str(document.file_path or "")).resolve()
    if not file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document file not found")
    return FileResponse(path=file_path, filename=document.file_name)


@router.post("/{document_id}/assist", response_model=DocumentAssistResponse)
async def assist_document(
    document_id: int,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> DocumentAssistResponse:
    """Builds compact next-step suggestions for a single document."""

    document = await _load_document_with_access(db=db, document_id=document_id, user=current_user)
    order = await _validate_order_access(db=db, order_id=int(document.order_id), user=current_user)
    finance = await _load_order_finance(db=db, order_id=int(order.id))
    payload = await build_document_assist_payload(document=document, order=order, finance=finance)
    await add_audit_log(
        db,
        actor_user_id=current_user.id,
        action="document_assisted",
        entity_type="document",
        entity_id=document.id,
        details={"mode": payload.get("mode"), "order_id": order.id},
    )
    await db.commit()
    return DocumentAssistResponse(document_id=document.id, **payload)


@router.get("/order/{order_id}/export")
async def export_order_documents(
    order_id: int,
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> StreamingResponse:
    """Downloads all order documents in a single zip archive."""

    await _validate_order_access(db=db, order_id=order_id, user=current_user)
    rows = await db.execute(
        select(MiniDocument)
        .where(MiniDocument.order_id == order_id, MiniDocument.deleted_at.is_(None))
        .order_by(desc(MiniDocument.id))
    )
    documents = rows.scalars().all()
    if not documents:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No documents for this order")

    buffer = BytesIO()
    with ZipFile(buffer, mode="w", compression=ZIP_DEFLATED) as archive:
        for document in documents:
            file_path = Path(str(document.file_path or "")).resolve()
            if file_path.exists():
                archive.write(file_path, arcname=document.file_name)
    buffer.seek(0)

    filename = f"order_{order_id}_documents.zip"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(buffer, media_type="application/zip", headers=headers)
