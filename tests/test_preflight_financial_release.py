from __future__ import annotations

from datetime import date
from decimal import Decimal

from scripts.preflight_financial_release import build_preflight_report


def _report(*, orders: list[dict], operations: list[dict]) -> dict:
    return build_preflight_report(
        database_url="sqlite+aiosqlite:///test.db",
        tables={"miniapp_orders", "miniapp_operations", "alembic_version"},
        alembic_version="20260424_000006",
        amount_column_type="NUMERIC(14, 2)",
        orders=orders,
        operations=operations,
        today=date(2026, 4, 24),
    )


def _codes(report: dict, severity: str | None = None) -> set[str]:
    return {
        item["code"]
        for item in report["issues"]
        if severity is None or item["severity"] == severity
    }


def test_financial_preflight_accepts_balanced_closed_order():
    report = _report(
        orders=[{"id": 1, "status": "closed", "order_phone": "+79990000001"}],
        operations=[
            {"id": 1, "date": "2026-04-24", "operation_type": "продажа", "amount": 1000, "order_id": 1},
            {"id": 2, "date": "2026-04-24", "operation_type": "оплата", "amount": 1000, "order_id": 1},
            {"id": 3, "date": "2026-04-24", "operation_type": "закупка", "amount": 400, "order_id": 1},
            {"id": 4, "date": "2026-04-24", "operation_type": "себестоимость", "amount": 400, "order_id": 1},
        ],
    )

    assert report["issue_counts"]["ERROR"] == 0
    assert report["issue_counts"]["WARN"] == 0


def test_financial_preflight_blocks_inconsistent_closed_order():
    report = _report(
        orders=[{"id": 1, "status": "closed", "order_phone": "+79990000001"}],
        operations=[
            {"id": 1, "date": "2026-04-24", "operation_type": "продажа", "amount": 1000, "order_id": 1},
            {"id": 2, "date": "2026-04-24", "operation_type": "оплата", "amount": 500, "order_id": 1},
            {"id": 3, "date": "2026-04-24", "operation_type": "закупка", "amount": 400, "order_id": 1},
            {"id": 4, "date": "2026-04-24", "operation_type": "себестоимость", "amount": 300, "order_id": 1},
        ],
    )

    assert {"CLOSED_ORDER_UNDERPAID", "CLOSED_ORDER_COGS_MISMATCH"} <= _codes(report, "ERROR")


def test_financial_preflight_flags_operation_data_risks():
    report = _report(
        orders=[{"id": 1, "status": "open", "order_phone": "+79990000001"}],
        operations=[
            {
                "id": 1,
                "date": "2026-04-24",
                "operation_type": "расход",
                "amount": Decimal("10.123"),
                "order_id": None,
            },
            {
                "id": 2,
                "date": "2026-04-25",
                "operation_type": "расход",
                "amount": 20,
                "order_id": None,
                "created_at": "2026-04-24T10:00:00",
            },
            {
                "id": 3,
                "date": "2026-04-24",
                "operation_type": "продажа",
                "amount": 100,
                "order_id": 999,
            },
            {
                "id": 4,
                "date": "bad-date",
                "operation_type": "оплата",
                "amount": -1,
                "order_id": None,
            },
        ],
    )

    assert {"AMOUNT_PRECISION_GT_2", "OPERATION_LINKS_MISSING_OR_DELETED_ORDER", "INVALID_OPERATION_DATE"} <= _codes(report, "ERROR")
    assert {"NEGATIVE_AMOUNT_FOR_UNSIGNED_TYPE", "ORDER_OPERATION_WITHOUT_ORDER"} <= _codes(report, "ERROR")
    assert "FUTURE_OPERATION_DATE" in _codes(report, "WARN")
    assert "STANDALONE_EXPENSE_DATE_DIFFERS_CREATED_AT" in _codes(report, "INFO")
