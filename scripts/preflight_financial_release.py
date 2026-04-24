#!/usr/bin/env python3
"""Read-only financial integrity preflight for Mini App releases."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import json
import math
from pathlib import Path
import sys
from typing import Any

from sqlalchemy import inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from miniapp_api.app.config import get_settings
from miniapp_api.app.services.order_finance import (
    ALL_OPERATION_TYPES,
    CASH_RECEIPT_OPERATION_TYPES,
    COGS_OPERATION_TYPES,
    PURCHASE_OPERATION_TYPES,
    REVENUE_OPERATION_TYPES,
    SIGNED_AMOUNT_OPERATION_TYPES,
    empty_order_finance,
    rollup_order_finance,
)


CURRENT_FINANCIAL_REVISION = "20260424_000006"
MONEY_EPSILON = 0.01
REQUIRED_TABLES = {"miniapp_orders", "miniapp_operations"}


@dataclass(frozen=True)
class Issue:
    severity: str
    code: str
    message: str
    entity: str | None = None
    entity_id: int | str | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DbSnapshot:
    database_url: str
    tables: set[str]
    alembic_version: str | None
    amount_column_type: str | None
    orders: list[dict[str, Any]]
    operations: list[dict[str, Any]]


def _redact_url(raw_url: str) -> str:
    try:
        return make_url(raw_url).render_as_string(hide_password=True)
    except Exception:  # noqa: BLE001
        return "<unparseable database url>"


def _to_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _to_decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    if not amount.is_finite():
        return None
    return amount


def _has_more_than_two_decimals(value: Any) -> bool:
    if isinstance(value, Decimal):
        return value != value.quantize(Decimal("0.01"))
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(amount):
        return False
    return abs(amount - round(amount, 2)) > 1e-9


def _parse_date(value: Any) -> date | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def _parse_created_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _money(value: Any) -> float:
    try:
        return round(float(value or 0.0), 2)
    except (TypeError, ValueError):
        return 0.0


def _issue(
    severity: str,
    code: str,
    message: str,
    *,
    entity: str | None = None,
    entity_id: int | str | None = None,
    details: dict[str, Any] | None = None,
) -> Issue:
    return Issue(
        severity=severity,
        code=code,
        message=message,
        entity=entity,
        entity_id=entity_id,
        details=details or {},
    )


def build_preflight_report(
    *,
    database_url: str,
    tables: set[str],
    alembic_version: str | None,
    amount_column_type: str | None,
    orders: list[dict[str, Any]],
    operations: list[dict[str, Any]],
    today: date | None = None,
) -> dict[str, Any]:
    """Builds a financial integrity report from already loaded DB rows."""

    today = today or date.today()
    issues: list[Issue] = []

    missing_tables = sorted(REQUIRED_TABLES - set(tables))
    for table_name in missing_tables:
        issues.append(
            _issue(
                "ERROR",
                "MISSING_TABLE",
                f"Required table is missing: {table_name}",
                entity="table",
                entity_id=table_name,
            )
        )

    if missing_tables:
        return _report_payload(
            database_url=database_url,
            alembic_version=alembic_version,
            amount_column_type=amount_column_type,
            orders_count=len(orders),
            operations_count=len(operations),
            issues=issues,
        )

    if alembic_version and str(alembic_version) < CURRENT_FINANCIAL_REVISION:
        issues.append(
            _issue(
                "INFO",
                "ALEMBIC_BEFORE_FINANCIAL_REVISION",
                "Database is before the financial Numeric migration; this is expected before deploy, but migration must run.",
                details={"current": alembic_version, "required": CURRENT_FINANCIAL_REVISION},
            )
        )
    elif not alembic_version:
        issues.append(
            _issue(
                "WARN",
                "ALEMBIC_VERSION_MISSING",
                "alembic_version row is missing; verify migration state before production deploy.",
            )
        )

    if amount_column_type and "NUMERIC" not in str(amount_column_type).upper() and "DECIMAL" not in str(amount_column_type).upper():
        issues.append(
            _issue(
                "INFO",
                "AMOUNT_COLUMN_NOT_NUMERIC_YET",
                "miniapp_operations.amount is not fixed precision yet; migration 20260424_000006 should convert it.",
                details={"amount_column_type": str(amount_column_type)},
            )
        )

    order_by_id = {
        int(order["id"]): order
        for order in orders
        if _to_int(order.get("id")) is not None
    }

    for operation in operations:
        op_id = _to_int(operation.get("id"))
        op_type = str(operation.get("operation_type") or "").strip().lower()
        order_id = _to_int(operation.get("order_id"))
        amount = _to_decimal(operation.get("amount"))
        operation_date = _parse_date(operation.get("date"))
        created_date = _parse_created_date(operation.get("created_at"))

        if op_type not in ALL_OPERATION_TYPES:
            issues.append(
                _issue(
                    "ERROR",
                    "UNKNOWN_OPERATION_TYPE",
                    f"Unknown operation type: {operation.get('operation_type')!r}",
                    entity="operation",
                    entity_id=op_id,
                )
            )

        if amount is None:
            issues.append(
                _issue(
                    "ERROR",
                    "INVALID_AMOUNT",
                    "Operation amount is empty, invalid, NaN or Infinity.",
                    entity="operation",
                    entity_id=op_id,
                    details={"amount": str(operation.get("amount"))},
                )
            )
        else:
            if amount == 0:
                issues.append(
                    _issue(
                        "ERROR",
                        "ZERO_AMOUNT",
                        "Operation amount is zero.",
                        entity="operation",
                        entity_id=op_id,
                        details={"operation_type": op_type},
                    )
                )
            if amount < 0 and op_type not in SIGNED_AMOUNT_OPERATION_TYPES:
                issues.append(
                    _issue(
                        "ERROR",
                        "NEGATIVE_AMOUNT_FOR_UNSIGNED_TYPE",
                        "Negative amount is only supported for sale adjustments and COGS corrections.",
                        entity="operation",
                        entity_id=op_id,
                        details={"operation_type": op_type, "amount": str(amount)},
                    )
                )
            if _has_more_than_two_decimals(operation.get("amount")):
                issues.append(
                    _issue(
                        "ERROR",
                        "AMOUNT_PRECISION_GT_2",
                        "Operation amount has more than 2 decimal places and will be rounded by the Numeric migration.",
                        entity="operation",
                        entity_id=op_id,
                        details={"amount": str(operation.get("amount"))},
                    )
                )

        if operation_date is None:
            issues.append(
                _issue(
                    "ERROR",
                    "INVALID_OPERATION_DATE",
                    "Operation date is empty or not ISO YYYY-MM-DD.",
                    entity="operation",
                    entity_id=op_id,
                    details={"date": str(operation.get("date"))},
                )
            )
        elif operation_date > today:
            issues.append(
                _issue(
                    "WARN",
                    "FUTURE_OPERATION_DATE",
                    "Operation is dated in the future and will not appear in current reports until that date.",
                    entity="operation",
                    entity_id=op_id,
                    details={"date": operation_date.isoformat(), "today": today.isoformat()},
                )
            )

        if order_id is not None and order_id not in order_by_id:
            issues.append(
                _issue(
                    "ERROR",
                    "OPERATION_LINKS_MISSING_OR_DELETED_ORDER",
                    "Operation references an order that is missing or deleted.",
                    entity="operation",
                    entity_id=op_id,
                    details={"order_id": order_id},
                )
            )

        order_required_types = REVENUE_OPERATION_TYPES | CASH_RECEIPT_OPERATION_TYPES | COGS_OPERATION_TYPES
        if op_type in order_required_types and order_id is None:
            issues.append(
                _issue(
                    "ERROR",
                    "ORDER_OPERATION_WITHOUT_ORDER",
                    "Order-bound operation has no order_id.",
                    entity="operation",
                    entity_id=op_id,
                    details={"operation_type": op_type},
                )
            )

        if (
            op_type == "расход"
            and order_id is None
            and operation_date is not None
            and created_date is not None
            and operation_date != created_date
        ):
            issues.append(
                _issue(
                    "INFO",
                    "STANDALONE_EXPENSE_DATE_DIFFERS_CREATED_AT",
                    "Standalone expense has operation date different from creation date; reports now use operation date.",
                    entity="operation",
                    entity_id=op_id,
                    details={
                        "operation_date": operation_date.isoformat(),
                        "created_date": created_date.isoformat(),
                    },
                )
            )

    finance_map = rollup_order_finance(operations)

    for order_id, order in order_by_id.items():
        status = str(order.get("status") or "").strip().lower()
        finance = finance_map.get(order_id, empty_order_finance())
        sale_amount = _money(finance.get("sale_amount"))
        paid_amount = _money(finance.get("paid_amount"))
        purchase_cost = _money(finance.get("purchase_cost"))
        recognized_cogs = _money(finance.get("recognized_cogs"))

        if status == "closed":
            if sale_amount <= 0:
                issues.append(
                    _issue("ERROR", "CLOSED_ORDER_NO_SALE", "Closed order has no sale amount.", entity="order", entity_id=order_id)
                )
            if purchase_cost <= 0:
                issues.append(
                    _issue("ERROR", "CLOSED_ORDER_NO_PURCHASE", "Closed order has no purchase cost.", entity="order", entity_id=order_id)
                )
            if paid_amount + MONEY_EPSILON < sale_amount:
                issues.append(
                    _issue(
                        "ERROR",
                        "CLOSED_ORDER_UNDERPAID",
                        "Closed order has unpaid balance.",
                        entity="order",
                        entity_id=order_id,
                        details={"sale_amount": sale_amount, "paid_amount": paid_amount},
                    )
                )
            if paid_amount - sale_amount > MONEY_EPSILON:
                issues.append(
                    _issue(
                        "ERROR",
                        "CLOSED_ORDER_OVERPAID",
                        "Closed order has overpayment.",
                        entity="order",
                        entity_id=order_id,
                        details={"sale_amount": sale_amount, "paid_amount": paid_amount},
                    )
                )
            if abs(recognized_cogs - purchase_cost) > MONEY_EPSILON:
                issues.append(
                    _issue(
                        "ERROR",
                        "CLOSED_ORDER_COGS_MISMATCH",
                        "Closed order recognized COGS differs from purchase cost.",
                        entity="order",
                        entity_id=order_id,
                        details={"purchase_cost": purchase_cost, "recognized_cogs": recognized_cogs},
                    )
                )
        elif status == "open":
            if recognized_cogs > MONEY_EPSILON:
                issues.append(
                    _issue(
                        "WARN",
                        "OPEN_ORDER_HAS_RECOGNIZED_COGS",
                        "Open order already has recognized COGS; check whether it was partially closed by old flow.",
                        entity="order",
                        entity_id=order_id,
                        details={"recognized_cogs": recognized_cogs},
                    )
                )
            if sale_amount > 0 and paid_amount - sale_amount > MONEY_EPSILON:
                issues.append(
                    _issue(
                        "WARN",
                        "OPEN_ORDER_OVERPAID",
                        "Open order is overpaid.",
                        entity="order",
                        entity_id=order_id,
                        details={"sale_amount": sale_amount, "paid_amount": paid_amount},
                    )
                )
            if (
                sale_amount > 0
                and purchase_cost > 0
                and abs(paid_amount - sale_amount) <= MONEY_EPSILON
                and recognized_cogs <= MONEY_EPSILON
            ):
                issues.append(
                    _issue(
                        "INFO",
                        "OPEN_ORDER_READY_TO_FINALIZE",
                        "Open order appears fully paid and ready for server-side finalization.",
                        entity="order",
                        entity_id=order_id,
                        details={"sale_amount": sale_amount, "paid_amount": paid_amount, "purchase_cost": purchase_cost},
                    )
                )
        else:
            issues.append(
                _issue(
                    "WARN",
                    "UNKNOWN_ORDER_STATUS",
                    "Order has an unexpected status.",
                    entity="order",
                    entity_id=order_id,
                    details={"status": status},
                )
            )

    return _report_payload(
        database_url=database_url,
        alembic_version=alembic_version,
        amount_column_type=amount_column_type,
        orders_count=len(orders),
        operations_count=len(operations),
        issues=issues,
    )


def _report_payload(
    *,
    database_url: str,
    alembic_version: str | None,
    amount_column_type: str | None,
    orders_count: int,
    operations_count: int,
    issues: list[Issue],
) -> dict[str, Any]:
    counts = {"ERROR": 0, "WARN": 0, "INFO": 0}
    for issue in issues:
        counts[issue.severity] = counts.get(issue.severity, 0) + 1
    return {
        "database_url": _redact_url(database_url),
        "alembic_version": alembic_version,
        "amount_column_type": amount_column_type,
        "orders_count": orders_count,
        "operations_count": operations_count,
        "issue_counts": counts,
        "issues": [asdict(issue) for issue in issues],
    }


async def load_snapshot() -> DbSnapshot:
    """Loads required rows from Mini App DB without mutating it."""

    settings = get_settings()
    database_url = settings.miniapp_database_url
    engine = create_async_engine(database_url, future=True)
    try:
        async with engine.connect() as connection:
            def _inspect(sync_conn):
                inspector = inspect(sync_conn)
                tables = set(inspector.get_table_names())
                amount_column_type = None
                if "miniapp_operations" in tables:
                    for column in inspector.get_columns("miniapp_operations"):
                        if column["name"] == "amount":
                            amount_column_type = str(column["type"])
                            break
                return tables, amount_column_type

            tables, amount_column_type = await connection.run_sync(_inspect)

            alembic_version = None
            if "alembic_version" in tables:
                alembic_version = (
                    await connection.execute(text("SELECT version_num FROM alembic_version LIMIT 1"))
                ).scalar_one_or_none()

            orders: list[dict[str, Any]] = []
            operations: list[dict[str, Any]] = []

            if REQUIRED_TABLES.issubset(tables):
                orders_result = await connection.execute(
                    text(
                        """
                        SELECT id, order_phone, client_name, status
                        FROM miniapp_orders
                        WHERE deleted_at IS NULL
                        ORDER BY id
                        """
                    )
                )
                orders = [dict(row) for row in orders_result.mappings().all()]

                operations_result = await connection.execute(
                    text(
                        """
                        SELECT id, date, operation_type, description, amount, order_id, created_at
                        FROM miniapp_operations
                        WHERE deleted_at IS NULL
                        ORDER BY id
                        """
                    )
                )
                operations = [dict(row) for row in operations_result.mappings().all()]

            return DbSnapshot(
                database_url=database_url,
                tables=tables,
                alembic_version=str(alembic_version) if alembic_version else None,
                amount_column_type=amount_column_type,
                orders=orders,
                operations=operations,
            )
    finally:
        await engine.dispose()


def print_human_report(report: dict[str, Any], *, limit: int) -> None:
    print("MINIAPP_FINANCIAL_PREFLIGHT")
    print(f"database: {report['database_url']}")
    print(f"alembic_version: {report['alembic_version'] or '-'}")
    print(f"amount_column_type: {report['amount_column_type'] or '-'}")
    print(f"orders: {report['orders_count']}")
    print(f"operations: {report['operations_count']}")
    counts = report["issue_counts"]
    print(f"issues: errors={counts.get('ERROR', 0)} warnings={counts.get('WARN', 0)} info={counts.get('INFO', 0)}")

    for severity in ("ERROR", "WARN", "INFO"):
        items = [item for item in report["issues"] if item["severity"] == severity]
        if not items:
            continue
        print()
        print(f"{severity}:")
        for item in items[:limit]:
            entity = ""
            if item.get("entity"):
                entity = f" {item['entity']}#{item.get('entity_id')}"
            details = f" details={json.dumps(item.get('details') or {}, ensure_ascii=False)}" if item.get("details") else ""
            print(f"- [{item['code']}]{entity}: {item['message']}{details}")
        if len(items) > limit:
            print(f"- ... {len(items) - limit} more {severity.lower()} issues hidden by --limit={limit}")

    print()
    if counts.get("ERROR", 0):
        print("PREFLIGHT_BLOCKED")
    else:
        print("PREFLIGHT_OK")


async def run(args: argparse.Namespace) -> int:
    snapshot = await load_snapshot()
    report = build_preflight_report(
        database_url=snapshot.database_url,
        tables=snapshot.tables,
        alembic_version=snapshot.alembic_version,
        amount_column_type=snapshot.amount_column_type,
        orders=snapshot.orders,
        operations=snapshot.operations,
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    else:
        print_human_report(report, limit=args.limit)

    counts = report["issue_counts"]
    if counts.get("ERROR", 0):
        return 1
    if args.fail_on_warnings and counts.get("WARN", 0):
        return 1
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only Mini App financial release preflight.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    parser.add_argument("--limit", type=int, default=20, help="Max issues per severity in human output.")
    parser.add_argument("--fail-on-warnings", action="store_true", help="Return non-zero when warnings exist.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
