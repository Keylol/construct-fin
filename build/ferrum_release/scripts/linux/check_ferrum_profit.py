from __future__ import annotations

import asyncio
from datetime import date
from pathlib import Path

from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from miniapp_api.app.models import MiniOperation, MiniOrder
from miniapp_api.app.services.reports import build_summary, resolve_period_start


def _read_env_value(path: Path, key: str) -> str:
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.strip().startswith("#"):
            continue
        current_key, value = line.split("=", 1)
        if current_key.strip() == key:
            return value.strip()
    raise KeyError(f"Missing {key} in {path}")


async def main() -> None:
    env_path = Path("/srv/construct/app/.env")
    database_url = _read_env_value(env_path, "MINIAPP_DATABASE_URL")
    engine = create_async_engine(database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    period_start = resolve_period_start(30)
    period_end = date.today().isoformat()

    async with session_factory() as db:
        op_rows = await db.execute(
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
                or_(
                    and_(MiniOperation.date >= period_start, MiniOperation.date <= period_end),
                    and_(
                        MiniOperation.operation_type == "расход",
                        MiniOperation.order_id.is_(None),
                        func.date(MiniOperation.created_at) >= period_start,
                        func.date(MiniOperation.created_at) <= period_end,
                    ),
                ),
            )
            .order_by(desc(MiniOperation.id))
        )
        operations = [
            {
                "date": (
                    created_at.date().isoformat()
                    if str(operation_type or "").strip().lower() == "расход" and order_id is None and created_at
                    else date_value
                ),
                "operation_type": operation_type,
                "amount": amount,
                "expense_category": expense_category,
                "order_id": order_id,
                "order_status": str(order_status or ""),
            }
            for date_value, operation_type, amount, expense_category, order_id, order_status, created_at in op_rows.all()
        ]

        order_rows = await db.execute(
            select(MiniOrder.id, MiniOrder.status)
            .where(MiniOrder.deleted_at.is_(None))
            .order_by(desc(MiniOrder.id))
        )
        visible_orders = [{"id": order_id, "status": str(order_status)} for order_id, order_status in order_rows.all()]

        order_op_rows = await db.execute(
            select(MiniOperation.order_id, MiniOperation.operation_type, MiniOperation.amount).where(
                MiniOperation.order_id.in_([int(item["id"]) for item in visible_orders]),
                MiniOperation.deleted_at.is_(None),
            )
        )
        all_order_operations = [
            {
                "order_id": order_id,
                "operation_type": operation_type,
                "amount": amount,
            }
            for order_id, operation_type, amount in order_op_rows.all()
        ]

    print("OPERATIONS_IN_PERIOD")
    for item in operations[:10]:
        print(item)
    print("SUMMARY")
    print(build_summary(operations, orders=visible_orders, all_order_operations=all_order_operations))

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
