"""Google Sheets sync bridge for Mini App data."""

from __future__ import annotations

from collections import defaultdict

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bot.services.sheets import sync_management_spreadsheet_from_operations
from miniapp_api.app.models import AppUser, MiniAuditLog, MiniDocument, MiniOperation, MiniOrder
from miniapp_api.app.services.order_finance import empty_order_finance, rollup_order_finance


def _build_review_flags(
    *,
    operation: MiniOperation,
    order: MiniOrder | None,
    finance: dict[str, float],
    documents_count: int,
    updated_operation_ids: set[int],
    reopened_order_ids: set[int],
) -> list[str]:
    flags: list[str] = []
    order_id = int(operation.order_id) if operation.order_id is not None else None
    op_type = str(operation.operation_type or "").strip().lower()

    if int(operation.id) in updated_operation_ids:
        flags.append("Операция изменялась")

    if order_id is None or order is None:
        return flags

    if int(order_id) in reopened_order_ids:
        flags.append("Заказ переоткрывали")
    if str(order.status or "").strip().lower() == "open":
        flags.append("Заказ не закрыт")
    if float(finance.get("balance_due") or 0.0) > 0.01:
        flags.append("Есть недоплата")
    if documents_count <= 0:
        flags.append("Нет файлов по заказу")
    if op_type == "закупка" and float(finance.get("sale_amount") or 0.0) <= 0.0:
        flags.append("Нет цены продажи")
    return flags


async def export_miniapp_operations_for_sheets(db: AsyncSession) -> list[dict]:
    """Exports visible Mini App operations into legacy workbook-compatible rows."""

    creator_user = aliased(AppUser)
    rows = await db.execute(
        select(MiniOperation, MiniOrder, creator_user)
        .join(creator_user, MiniOperation.created_by_user_id == creator_user.id)
        .outerjoin(MiniOrder, MiniOperation.order_id == MiniOrder.id)
        .where(MiniOperation.deleted_at.is_(None))
        .order_by(MiniOperation.id.asc())
    )
    records = rows.all()

    order_ids = sorted(
        {
            int(order.id)
            for _, order, _ in records
            if order is not None and order.deleted_at is None
        }
    )

    finance_map = empty_order_finance()
    finance_by_order: dict[int, dict[str, float]] = {}
    if order_ids:
        order_operation_rows = await db.execute(
            select(MiniOperation.order_id, MiniOperation.operation_type, MiniOperation.amount).where(
                MiniOperation.order_id.in_(order_ids),
                MiniOperation.deleted_at.is_(None),
            )
        )
        finance_by_order = rollup_order_finance(
            [
                {
                    "order_id": order_id,
                    "operation_type": operation_type,
                    "amount": amount,
                }
                for order_id, operation_type, amount in order_operation_rows.all()
            ]
        )

    documents_count_by_order: dict[int, int] = defaultdict(int)
    if order_ids:
        doc_rows = await db.execute(
            select(MiniDocument.order_id, func.count(MiniDocument.id))
            .where(MiniDocument.order_id.in_(order_ids), MiniDocument.deleted_at.is_(None))
            .group_by(MiniDocument.order_id)
        )
        documents_count_by_order = defaultdict(int, {int(order_id): int(count or 0) for order_id, count in doc_rows.all()})

    updated_operation_ids: set[int] = set()
    reopened_order_ids: set[int] = set()
    if order_ids:
        audit_rows = await db.execute(
            select(MiniAuditLog.action, MiniAuditLog.entity_type, MiniAuditLog.entity_id).where(
                MiniAuditLog.entity_type.in_(("operation", "order")),
                MiniAuditLog.entity_id.is_not(None),
            )
        )
        for action, entity_type, entity_id in audit_rows.all():
            if entity_id is None:
                continue
            if str(entity_type) == "operation" and str(action) == "operation_updated":
                updated_operation_ids.add(int(entity_id))
            if str(entity_type) == "order" and str(action) == "order_reopened":
                reopened_order_ids.add(int(entity_id))

    exported_rows: list[dict] = []
    for operation, order, creator in records:
        if order is not None and order.deleted_at is not None:
            continue

        order_id = int(operation.order_id) if operation.order_id is not None else None
        finance = finance_by_order.get(order_id, finance_map) if order_id is not None else finance_map
        review_flags = _build_review_flags(
            operation=operation,
            order=order,
            finance=finance,
            documents_count=int(documents_count_by_order.get(order_id or 0, 0)),
            updated_operation_ids=updated_operation_ids,
            reopened_order_ids=reopened_order_ids,
        )
        creator_label = (
            str(creator.username or "").strip()
            or " ".join(part for part in [creator.first_name, creator.last_name] if part).strip()
            or str(creator.id)
        )

        exported_rows.append(
            {
                "id": int(operation.id),
                "date": str(operation.date or ""),
                "operation_type": str(operation.operation_type or ""),
                "description": str(operation.description or ""),
                "amount": float(operation.amount or 0.0),
                "supplier": str(operation.supplier or ""),
                "expense_category": str(operation.expense_category or ""),
                "expense_subcategory": str(operation.expense_subcategory or ""),
                "payment_account": str(operation.payment_account or ""),
                "payment_method": str(operation.payment_method or ""),
                "income_channel": str(operation.income_channel or ""),
                "sale_type": str(operation.sale_type or ""),
                "order_id": order_id,
                "order_phone": str(order.order_phone or "") if order else "",
                "client_name": str(order.client_name or "") if order else "",
                "order_status": str(order.status or "") if order else "",
                "comment": "",
                "created_by": creator_label,
                "source_system": "miniapp",
                "review_flags": review_flags,
            }
        )

    return exported_rows


async def sync_google_sheets_from_miniapp(db: AsyncSession) -> dict:
    """Builds workbook from current Mini App data set."""

    operations = await export_miniapp_operations_for_sheets(db)
    result = await sync_management_spreadsheet_from_operations(operations)
    result["operations_exported"] = len(operations)
    result["review_items"] = sum(1 for item in operations if item.get("review_flags"))
    return result
