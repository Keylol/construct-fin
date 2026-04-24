"""Normalization/validation helpers for Mini App operations."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

import config as legacy_config
from miniapp_api.app.services.order_finance import (
    ALL_OPERATION_TYPES,
    CASH_RECEIPT_OPERATION_TYPES,
    REVENUE_OPERATION_TYPES,
    SIGNED_AMOUNT_OPERATION_TYPES,
)

INCOME_TYPES = REVENUE_OPERATION_TYPES | CASH_RECEIPT_OPERATION_TYPES

OPERATION_ALIASES = {
    "sale": "продажа",
    "purchase": "закупка",
    "expense": "расход",
    "prepayment": "предоплата",
    "postpayment": "постоплата",
    "payment": "оплата",
    "sale_adjustment": "корректировка продажи",
    "cogs": "себестоимость",
}


def normalize_operation_type(raw_value: str | None) -> str:
    """Maps operation type aliases to canonical values."""

    value = str(raw_value or "").strip().lower()
    if not value:
        return "расход"
    return OPERATION_ALIASES.get(value, value)


def _normalize_date(raw_value: str | None) -> tuple[str, bool]:
    value = str(raw_value or "").strip()
    if not value:
        return datetime.now().date().isoformat(), False
    try:
        return datetime.strptime(value[:10], "%Y-%m-%d").date().isoformat(), False
    except ValueError:
        return value[:10], True


def _normalize_amount(raw_value: Any) -> Decimal:
    value = raw_value
    if isinstance(value, str):
        value = value.replace(" ", "").replace(",", ".").strip()
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")
    if not amount.is_finite():
        return Decimal("0")
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def normalize_operation_payload(
    payload: dict[str, Any],
    *,
    source_text: str | None = None,
) -> dict[str, Any]:
    """Builds canonical operation payload from manual or text parse input."""

    operation_type = normalize_operation_type(payload.get("operation_type"))
    description = str(payload.get("description") or source_text or "").strip()
    date_value, invalid_date = _normalize_date(payload.get("date"))
    amount = _normalize_amount(payload.get("amount"))

    payment_account = legacy_config.normalize_payment_account(payload.get("payment_account"))
    if not payment_account:
        payment_account = legacy_config.default_payment_account_for_operation(operation_type)

    payment_method = str(payload.get("payment_method") or "").strip().lower()
    if payment_method not in legacy_config.PAYMENT_METHODS:
        payment_method = legacy_config.payment_method_for_account(payment_account, description)

    sale_type = str(payload.get("sale_type") or "Сборка").strip().title()
    if sale_type not in legacy_config.SALE_TYPES:
        sale_type = "Сборка"

    income_channel = str(payload.get("income_channel") or "").strip()
    if income_channel and income_channel not in legacy_config.INCOME_CHANNELS:
        income_channel = "Онлайн"
    if not income_channel and operation_type in INCOME_TYPES:
        income_channel = "Онлайн"

    category_raw = payload.get("expense_category")
    subcategory_raw = payload.get("expense_subcategory")
    if operation_type == "закупка" and not category_raw:
        category_raw = "Комплектующие"

    category, subcategory = legacy_config.normalize_expense_taxonomy(
        category=(str(category_raw).strip() if category_raw else None),
        subcategory=(str(subcategory_raw).strip() if subcategory_raw else None),
        description=description,
    )

    if operation_type in INCOME_TYPES:
        category = None
        subcategory = None

    normalized = {
        "date": date_value,
        "operation_type": operation_type,
        "description": description,
        "amount": amount,
        "supplier": (str(payload.get("supplier")).strip() if payload.get("supplier") else None),
        "expense_category": category,
        "expense_subcategory": subcategory,
        "payment_account": payment_account,
        "payment_method": payment_method,
        "income_channel": income_channel or None,
        "sale_type": sale_type,
        "order_id": payload.get("order_id"),
        "_invalid_date": invalid_date,
    }
    return normalized


def validate_operation_payload(payload: dict[str, Any]) -> list[str]:
    """Validates canonical operation payload and returns missing/invalid fields."""

    missing: list[str] = []

    operation_type = str(payload.get("operation_type") or "")
    if operation_type not in ALL_OPERATION_TYPES:
        missing.append("operation_type")

    amount = Decimal(str(payload.get("amount") or 0))
    if operation_type in SIGNED_AMOUNT_OPERATION_TYPES:
        if abs(amount) <= 0:
            missing.append("amount")
    elif amount <= 0:
        missing.append("amount")
    if not str(payload.get("description") or "").strip():
        missing.append("description")
    if payload.get("_invalid_date"):
        missing.append("date")

    if operation_type in INCOME_TYPES and not payload.get("order_id"):
        missing.append("order_id")
    if operation_type == "себестоимость" and not payload.get("order_id"):
        missing.append("order_id")

    if operation_type == "расход":
        if not payload.get("expense_category"):
            missing.append("expense_category")
        if not payload.get("payment_account"):
            missing.append("payment_account")

    if operation_type == "закупка" and not payload.get("payment_account"):
        missing.append("payment_account")
    if operation_type == "оплата" and not payload.get("payment_account"):
        missing.append("payment_account")

    # Preserve order of checks and remove duplicates.
    deduped: list[str] = []
    for item in missing:
        if item not in deduped:
            deduped.append(item)
    return deduped
