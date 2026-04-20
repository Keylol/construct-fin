"""Report aggregation helpers for Mini App analytics cards/charts."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

import config as legacy_config
from miniapp_api.app.services.order_finance import (
    CASH_RECEIPT_OPERATION_TYPES,
    COGS_OPERATION_TYPES,
    REVENUE_OPERATION_TYPES,
    rollup_order_finance,
)



def resolve_period_start(days: int) -> str:
    """Returns ISO date for report period start."""

    normalized_days = max(1, min(int(days or 30), 365))
    return (date.today() - timedelta(days=normalized_days - 1)).isoformat()


def build_summary(
    period_operations: list[dict],
    *,
    orders: list[dict],
    all_order_operations: list[dict],
) -> dict:
    """Builds top-level totals for dashboard cards."""

    income = 0.0
    cash_received = 0.0
    purchases = 0.0
    commercial = 0.0
    non_operating = 0.0
    sales_count = 0
    order_status_by_id = {
        int(order.get("id") or 0): str(order.get("status") or "").strip().lower()
        for order in orders
        if order.get("id") is not None
    }

    for item in period_operations:
        op_type = str(item.get("operation_type") or "").strip().lower()
        amount = float(item.get("amount") or 0.0)
        order_id = item.get("order_id")
        order_status = order_status_by_id.get(int(order_id or 0), str(item.get("order_status") or "").strip().lower())
        is_closed_order = order_status == "closed"

        if op_type in REVENUE_OPERATION_TYPES and is_closed_order:
            income += amount
            if op_type == "продажа":
                sales_count += 1
            continue
        if op_type in CASH_RECEIPT_OPERATION_TYPES:
            cash_received += amount
            continue
        if op_type in COGS_OPERATION_TYPES and is_closed_order:
            purchases += amount
            continue
        if op_type == "расход":
            category = str(item.get("expense_category") or "").strip()
            if category in legacy_config.COMMERCIAL_EXPENSE_CATEGORIES:
                commercial += amount
            else:
                non_operating += amount

    other_expenses = commercial + non_operating
    total_expenses = purchases + other_expenses
    profit = income - total_expenses
    order_finance = rollup_order_finance(all_order_operations)

    open_orders_count = 0
    open_orders_revenue = 0.0
    open_orders_paid = 0.0
    open_orders_balance_due = 0.0
    wip_amount = 0.0

    for order in orders:
        order_id = int(order.get("id") or 0)
        finance = order_finance.get(order_id, {})
        sale_amount = float(finance.get("sale_amount") or 0.0)
        if sale_amount <= 0:
            continue
        if str(order.get("status") or "").strip().lower() != "open":
            continue

        paid_amount = float(finance.get("paid_amount") or 0.0)
        purchase_cost = float(finance.get("purchase_cost") or 0.0)
        recognized_cogs = float(finance.get("recognized_cogs") or 0.0)

        open_orders_count += 1
        open_orders_revenue += sale_amount
        open_orders_paid += paid_amount
        open_orders_balance_due += max(sale_amount - paid_amount, 0.0)
        wip_amount += max(purchase_cost - recognized_cogs, 0.0)

    return {
        "income": round(income, 2),
        "average_ticket": round(income / max(sales_count, 1), 2) if income > 0 else 0.0,
        "cash_received": round(cash_received, 2),
        "purchases": round(purchases, 2),
        "other_expenses": round(other_expenses, 2),
        "commercial_expenses": round(commercial, 2),
        "non_operating_expenses": round(non_operating, 2),
        "total_expenses": round(total_expenses, 2),
        "profit": round(profit, 2),
        "operations_count": len(period_operations),
        "open_orders_count": int(open_orders_count),
        "open_orders_revenue": round(open_orders_revenue, 2),
        "open_orders_paid": round(open_orders_paid, 2),
        "open_orders_balance_due": round(open_orders_balance_due, 2),
        "wip_amount": round(wip_amount, 2),
    }


def build_timeseries(operations: list[dict]) -> list[dict]:
    """Builds date-wise metrics for charts."""

    by_date: dict[str, dict[str, float]] = defaultdict(
        lambda: {"income": 0.0, "cash_received": 0.0, "expenses": 0.0, "profit": 0.0}
    )
    for item in operations:
        day = str(item.get("date") or "").strip()
        if not day:
            continue

        op_type = str(item.get("operation_type") or "").strip().lower()
        amount = float(item.get("amount") or 0.0)
        order_status = str(item.get("order_status") or "").strip().lower()
        is_closed_order = order_status == "closed"
        if op_type in REVENUE_OPERATION_TYPES and is_closed_order:
            by_date[day]["income"] += amount
            by_date[day]["profit"] += amount
        elif op_type in CASH_RECEIPT_OPERATION_TYPES:
            by_date[day]["cash_received"] += amount
        elif (op_type in COGS_OPERATION_TYPES and is_closed_order) or op_type == "расход":
            by_date[day]["expenses"] += amount
            by_date[day]["profit"] -= amount

    result = []
    for day in sorted(by_date):
        row = by_date[day]
        result.append(
            {
                "date": day,
                "income": round(row["income"], 2),
                "cash_received": round(row["cash_received"], 2),
                "expenses": round(row["expenses"], 2),
                "profit": round(row["profit"], 2),
            }
        )
    return result
