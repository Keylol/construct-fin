"""Shared finance rollups for orders and management reports."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

import config as legacy_config


REVENUE_OPERATION_TYPES = {"продажа", "корректировка продажи"}
CASH_RECEIPT_OPERATION_TYPES = {"предоплата", "постоплата", "оплата"}
COGS_OPERATION_TYPES = {"себестоимость"}
PURCHASE_OPERATION_TYPES = {"закупка"}
SYSTEM_OPERATION_TYPES = {"оплата", "корректировка продажи", "себестоимость"}
ALL_OPERATION_TYPES = set(legacy_config.OPERATION_TYPES) | SYSTEM_OPERATION_TYPES
SIGNED_AMOUNT_OPERATION_TYPES = {"корректировка продажи", "себестоимость"}


def empty_order_finance() -> dict[str, float]:
    """Returns empty rollup payload for a single order."""

    return {
        "sale_amount": 0.0,
        "paid_amount": 0.0,
        "prepayment_amount": 0.0,
        "postpayment_amount": 0.0,
        "payment_receipt_amount": 0.0,
        "purchase_cost": 0.0,
        "recognized_cogs": 0.0,
        "balance_due": 0.0,
    }


def rollup_order_finance(operations: list[dict[str, Any]]) -> dict[int, dict[str, float]]:
    """Aggregates current financial state for each order from operation history."""

    by_order: dict[int, dict[str, float]] = defaultdict(empty_order_finance)

    for item in operations:
        order_id = item.get("order_id")
        if order_id in (None, ""):
            continue

        op_type = str(item.get("operation_type") or "").strip().lower()
        amount = float(item.get("amount") or 0.0)
        bucket = by_order[int(order_id)]

        if op_type in REVENUE_OPERATION_TYPES:
            bucket["sale_amount"] += amount
        elif op_type == "предоплата":
            bucket["prepayment_amount"] += amount
            bucket["paid_amount"] += amount
        elif op_type == "постоплата":
            bucket["postpayment_amount"] += amount
            bucket["paid_amount"] += amount
        elif op_type == "оплата":
            bucket["payment_receipt_amount"] += amount
            bucket["paid_amount"] += amount
        elif op_type in PURCHASE_OPERATION_TYPES:
            bucket["purchase_cost"] += amount
        elif op_type in COGS_OPERATION_TYPES:
            bucket["recognized_cogs"] += amount

    for bucket in by_order.values():
        bucket["balance_due"] = round(bucket["sale_amount"] - bucket["paid_amount"], 2)
        for key, value in list(bucket.items()):
            bucket[key] = round(float(value or 0.0), 2)

    return dict(by_order)

