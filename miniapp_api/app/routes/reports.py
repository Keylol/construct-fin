"""Report routes for Mini App dashboard cards/charts."""

from __future__ import annotations

import csv
from datetime import date
from io import StringIO

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from miniapp_api.app.config import get_settings
from miniapp_api.app.db import get_db_session
from miniapp_api.app.deps import require_roles
from miniapp_api.app.models import AppUser, MiniOperation, MiniOrder
from miniapp_api.app.schemas import ReportPointDTO, ReportSummaryDTO
from miniapp_api.app.services.reports import build_summary, build_timeseries, resolve_period_start


router = APIRouter(prefix="/reports", tags=["reports"])


async def _load_operations(
    *,
    db: AsyncSession,
    current_user: AppUser,
    days: int,
) -> tuple[list[dict], str, str, int]:
    normalized_days = max(1, min(int(days or 30), 365))
    period_start = resolve_period_start(normalized_days)
    period_end = date.today().isoformat()

    stmt = (
        select(
            MiniOperation.date,
            MiniOperation.operation_type,
            MiniOperation.amount,
            MiniOperation.expense_category,
            MiniOperation.order_id,
            MiniOrder.status,
            MiniOperation.created_at,
        )
        .outerjoin(MiniOrder, MiniOperation.order_id == MiniOrder.id)
        .where(
            MiniOperation.deleted_at.is_(None),
            MiniOperation.date >= period_start,
            MiniOperation.date <= period_end,
        )
        .order_by(desc(MiniOperation.id))
    )

    rows = await db.execute(stmt)
    operations = [
        {
            "date": date_value,
            "operation_type": operation_type,
            "amount": amount,
            "expense_category": expense_category,
            "order_id": order_id,
            "order_status": str(order_status or ""),
        }
        for date_value, operation_type, amount, expense_category, order_id, order_status, _created_at in rows.all()
    ]
    return operations, period_start, period_end, normalized_days


async def _load_visible_orders(*, db: AsyncSession, current_user: AppUser) -> list[dict]:
    stmt = select(MiniOrder.id, MiniOrder.status).where(MiniOrder.deleted_at.is_(None)).order_by(desc(MiniOrder.id))

    rows = await db.execute(stmt)
    return [{"id": order_id, "status": str(order_status)} for order_id, order_status in rows.all()]


async def _load_order_operations(*, db: AsyncSession, order_ids: list[int]) -> list[dict]:
    if not order_ids:
        return []

    rows = await db.execute(
        select(MiniOperation.order_id, MiniOperation.operation_type, MiniOperation.amount).where(
            MiniOperation.order_id.in_(order_ids),
            MiniOperation.deleted_at.is_(None),
        )
    )
    return [
        {
            "order_id": order_id,
            "operation_type": operation_type,
            "amount": amount,
        }
        for order_id, operation_type, amount in rows.all()
    ]


@router.get("/summary", response_model=ReportSummaryDTO)
async def get_report_summary(
    days: int | None = Query(default=None, ge=1, le=365),
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> ReportSummaryDTO:
    """Returns aggregate period metrics."""

    settings = get_settings()
    requested_days = days or int(settings.miniapp_report_default_days or 7)
    operations, period_start, period_end, normalized_days = await _load_operations(
        db=db,
        current_user=current_user,
        days=requested_days,
    )
    visible_orders = await _load_visible_orders(db=db, current_user=current_user)
    order_operations = await _load_order_operations(
        db=db,
        order_ids=[int(item["id"]) for item in visible_orders],
    )
    summary = build_summary(
        operations,
        orders=visible_orders,
        all_order_operations=order_operations,
    )
    return ReportSummaryDTO(
        period_start=period_start,
        period_end=period_end,
        days=normalized_days,
        **summary,
    )


@router.get("/timeseries", response_model=list[ReportPointDTO])
async def get_report_timeseries(
    days: int | None = Query(default=None, ge=1, le=365),
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> list[ReportPointDTO]:
    """Returns daily points for chart rendering."""

    settings = get_settings()
    requested_days = days or int(settings.miniapp_report_default_days or 7)
    operations, _, _, _ = await _load_operations(
        db=db,
        current_user=current_user,
        days=requested_days,
    )
    return [ReportPointDTO(**item) for item in build_timeseries(operations)]


@router.get("/export.csv")
async def export_report_csv(
    days: int | None = Query(default=None, ge=1, le=365),
    db: AsyncSession = Depends(get_db_session),
    current_user: AppUser = Depends(require_roles("owner", "operator")),
) -> Response:
    """Exports period operations to CSV for current user's visibility scope."""

    settings = get_settings()
    requested_days = days or int(settings.miniapp_report_default_days or 7)
    period_start = resolve_period_start(requested_days)
    period_end = date.today().isoformat()

    stmt = (
        select(MiniOperation)
        .where(
            MiniOperation.deleted_at.is_(None),
            MiniOperation.date >= period_start,
            MiniOperation.date <= period_end,
        )
        .order_by(desc(MiniOperation.id))
    )
    rows = (await db.execute(stmt)).scalars().all()
    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "id",
            "date",
            "operation_type",
            "description",
            "amount",
            "supplier",
            "expense_category",
            "expense_subcategory",
            "payment_account",
            "payment_method",
            "income_channel",
            "sale_type",
            "order_id",
            "created_by_user_id",
            "created_at",
        ]
    )
    for item in rows:
        writer.writerow(
            [
                item.id,
                item.date,
                item.operation_type,
                item.description,
                item.amount,
                item.supplier or "",
                item.expense_category or "",
                item.expense_subcategory or "",
                item.payment_account or "",
                item.payment_method or "",
                item.income_channel or "",
                item.sale_type or "",
                item.order_id or "",
                item.created_by_user_id,
                item.created_at.isoformat() if item.created_at else "",
            ]
        )

    filename = f"miniapp_report_{period_start}_{period_end}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
