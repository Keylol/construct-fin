"""Google Sheets bootstrap and sync for monthly management accounting workbook."""

from __future__ import annotations

import asyncio
import logging
import os
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import gspread
from gspread.http_client import HTTPClient

import config
from bot.services.database import get_all_operations_for_export

logger = logging.getLogger(__name__)

SPREADSHEET_ID_FILE = config.DATA_DIR / "spreadsheet_id.txt"
REFERENCE_SHEET = "Справочник расходов"
DASHBOARD_SHEET = "Дашборд"
BUDGET_PLAN_SHEET = "Бюджет план"
SPECS_SHEET = "Specs"
SPECS_REVIEW_SHEET = "Specs Review"
PRINT_SHEET = "Print"
OPERATIONS_REGISTER_SHEET = "Реестр операций"
PL_SHEET = "ОПиУ"
CASHFLOW_SHEET = "ДДС"
PLAN_FACT_SHEET = "План-факт"
UNIT_ECONOMICS_SHEET = "Unit-экономика по заказам"
DATA_QUALITY_SHEET = "Контроль качества"

MONTH_NAMES = {
    1: "Январь",
    2: "Февраль",
    3: "Март",
    4: "Апрель",
    5: "Май",
    6: "Июнь",
    7: "Июль",
    8: "Август",
    9: "Сентябрь",
    10: "Октябрь",
    11: "Ноябрь",
    12: "Декабрь",
}


class NoProxyHTTPClient(HTTPClient):
    """Disables environment proxy settings for Google Sheets requests."""

    def __init__(self, auth, session=None) -> None:
        super().__init__(auth, session=session)
        self.session.trust_env = False
        self.session.proxies = {}


def _parse_float(value) -> float:
    if value in (None, ""):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    normalized = str(value).replace(" ", "").replace(",", ".")
    try:
        return float(normalized)
    except ValueError:
        return 0.0


def _looks_like_iso_date(value: str) -> bool:
    normalized = str(value or "").strip()
    if len(normalized) < 10:
        return False
    try:
        datetime.strptime(normalized[:10], "%Y-%m-%d")
    except ValueError:
        return False
    return True


def _month_key(date_value: str | None) -> str:
    normalized = str(date_value or "").strip()
    if len(normalized) >= 7:
        return normalized[:7]
    return ""


def _month_title(month_key: str) -> str:
    try:
        dt = datetime.strptime(month_key, "%Y-%m")
        return f"{MONTH_NAMES[dt.month]} {dt.year}"
    except Exception:
        return month_key


def _expense_sheet_title(month_key: str) -> str:
    return f"Журнал расходов {_month_title(month_key)}"


def _income_sheet_title(month_key: str) -> str:
    return f"Доход {_month_title(month_key)}"


def _summary_sheet_title(month_key: str) -> str:
    return f"Итог {_month_title(month_key)}"


def _normalize_operation(operation: dict) -> dict:
    normalized = dict(operation)
    normalized["source_system"] = str(normalized.get("source_system") or "").strip().lower()
    normalized["operation_type"] = str(normalized.get("operation_type") or "").strip().lower()
    normalized["date"] = str(normalized.get("date") or "").strip()
    normalized["description"] = str(normalized.get("description") or "").strip()
    normalized["amount"] = _parse_float(normalized.get("amount"))
    normalized["expense_category"] = str(normalized.get("expense_category") or "").strip()
    normalized["expense_subcategory"] = str(normalized.get("expense_subcategory") or "").strip()
    normalized["expense_block"] = str(normalized.get("expense_block") or "").strip()
    normalized["supplier"] = str(normalized.get("supplier") or "").strip()
    normalized["payment_account"] = str(normalized.get("payment_account") or "").strip()
    normalized["client_name"] = str(normalized.get("client_name") or "").strip()
    normalized["order_phone"] = str(
        normalized.get("order_phone") or normalized.get("client_phone") or ""
    ).strip()
    normalized["comment"] = str(normalized.get("comment") or "").strip()
    normalized["sale_type"] = str(
        normalized.get("sale_type") or normalized.get("order_sale_type") or "Сборка"
    ).strip()
    normalized["income_channel"] = str(normalized.get("income_channel") or "").strip()
    normalized["order_id"] = normalized.get("order_id")

    category, subcategory = config.normalize_expense_taxonomy(
        category=normalized.get("expense_category"),
        subcategory=normalized.get("expense_subcategory"),
        description=normalized.get("description"),
    )
    normalized["expense_category"] = category or ""
    normalized["expense_subcategory"] = subcategory or ""
    normalized["expense_block"] = normalized["expense_block"] or str(config.expense_block(category) or "")
    return normalized


def _sorted_operations(operations: list[dict]) -> list[dict]:
    normalized = [_normalize_operation(item) for item in operations]
    return sorted(
        normalized,
        key=lambda item: (
            item.get("date", ""),
            int(item.get("id") or 0),
        ),
    )


def _is_spec_aggregate_operation(operation: dict) -> bool:
    comment = str(operation.get("comment") or "").strip().lower()
    return comment.startswith("spec_aggregate:")


def _build_order_cogs_map(all_operations: list[dict]) -> dict[int, float]:
    result: dict[int, float] = defaultdict(float)
    for operation in _sorted_operations(all_operations):
        if (
            operation["operation_type"] == "закупка"
            and operation.get("order_id")
            and not _is_spec_aggregate_operation(operation)
        ):
            result[int(operation["order_id"])] += operation["amount"]
    return result


def build_reference_sheet_rows() -> list[list]:
    rows = [["Категория расходов"]]
    for category in config.EXPENSE_CATEGORIES:
        rows.append([category])
    return rows


def build_budget_plan_seed_rows(month_keys: list[str]) -> list[list]:
    rows = [[
        "Месяц",
        "Выручка план",
        "Себестоимость план",
        "Валовая прибыль план",
        "Оперрасходы план",
        "Чистая прибыль план",
    ]]
    for month_key in month_keys:
        rows.append([month_key, "", "", "", "", ""])
    return rows


def parse_budget_plan_rows(values: list[list]) -> dict[str, dict[str, float]]:
    plan_map: dict[str, dict[str, float]] = {}
    for row in values[1:]:
        padded = list(row) + [""] * (6 - len(row))
        month, rev, cogs, gross, opex, net = padded[:6]
        month_key = str(month).strip()
        if not month_key:
            continue
        plan_map[month_key] = {
            "revenue": _parse_float(rev),
            "cogs": _parse_float(cogs),
            "gross": _parse_float(gross),
            "opex": _parse_float(opex),
            "net": _parse_float(net),
        }
    return plan_map


def build_expense_journal_rows(operations: list[dict]) -> list[list]:
    rows = [[
        "Дата",
        "Категория",
        "Описание",
        "Сумма",
        "Счет",
        "Поставщик",
        "№ заказа",
        "Комментарий",
    ]]

    for operation in _sorted_operations(operations):
        if operation["operation_type"] not in {"закупка", "расход"}:
            continue
        category = operation["expense_category"]
        if not category:
            category = "Комплектующие" if operation["operation_type"] == "закупка" else "Без категории"
        rows.append([
            operation["date"],
            category,
            operation["description"],
            operation["amount"],
            operation["payment_account"],
            operation["supplier"],
            operation["order_phone"],
            operation["comment"],
        ])

    if len(rows) == 1:
        rows.append(["", "", "Нет данных", 0.0, "", "", "", ""])
    return rows


def build_income_rows(month_operations: list[dict], all_operations: list[dict]) -> list[list]:
    rows = [[
        "Дата",
        "Тип продажи",
        "№ заказа",
        "Клиент",
        "Описание",
        "Цена продажи",
        "Стоимость закупки",
        "Маржа ₽",
        "Маржа %",
        "Канал",
        "Счет",
        "Комментарий",
    ]]

    cogs_by_order = _build_order_cogs_map(all_operations)

    for operation in _sorted_operations(month_operations):
        if operation["operation_type"] not in {"продажа", "корректировка продажи", "предоплата", "постоплата"}:
            continue
        cogs_value = 0.0
        if operation["operation_type"] == "продажа" and operation.get("order_id"):
            cogs_value = cogs_by_order.get(int(operation["order_id"]), 0.0)
        margin_value = operation["amount"] - cogs_value
        margin_pct = (margin_value / operation["amount"] * 100.0) if operation["amount"] > 0 else 0.0
        rows.append([
            operation["date"],
            operation["sale_type"] or "Сборка",
            operation["order_phone"],
            operation["client_name"],
            operation["description"],
            operation["amount"],
            cogs_value,
            margin_value,
            round(margin_pct, 2),
            operation["income_channel"] or "Онлайн",
            operation["payment_account"],
            operation["comment"],
        ])

    if len(rows) == 1:
        rows.append(["", "", "", "", "Нет данных", 0.0, 0.0, 0.0, 0.0, "", "", ""])
    return rows


def build_month_summary_rows(operations: list[dict], all_operations: list[dict] | None = None) -> list[list]:
    source_operations = all_operations or operations
    cogs_by_order = _build_order_cogs_map(source_operations)
    sold_order_ids = {
        int(operation["order_id"])
        for operation in operations
        if _is_sale_recognition_operation(operation) and operation.get("order_id")
    }

    revenue = sum(
        operation["amount"]
        for operation in operations
        if _is_revenue_operation(operation)
    )
    cogs = sum(cogs_by_order.get(order_id, 0.0) for order_id in sold_order_ids)
    gross = revenue - cogs
    opex = sum(operation["amount"] for operation in operations if operation["operation_type"] == "расход")
    net = gross - opex

    return [
        ["Показатель", "Сумма"],
        ["Выручка", revenue],
        ["Себестоимость", cogs],
        ["Валовая прибыль", gross],
        ["Оперрасходы", opex],
        ["Чистая прибыль", net],
    ]


def _is_closed_order(operation: dict) -> bool:
    status = str(operation.get("order_status") or "").strip().lower()
    if not status:
        return True
    return status == "closed"


def _is_revenue_operation(operation: dict) -> bool:
    return operation.get("operation_type") in {"продажа", "корректировка продажи"} and _is_closed_order(operation)


def _is_sale_recognition_operation(operation: dict) -> bool:
    return operation.get("operation_type") == "продажа" and _is_closed_order(operation)


def _is_cash_in_operation(operation: dict) -> bool:
    return operation.get("operation_type") in {"предоплата", "постоплата", "оплата"}


def _is_purchase_operation(operation: dict) -> bool:
    return operation.get("operation_type") == "закупка" and not _is_spec_aggregate_operation(operation)


def _is_commercial_expense(operation: dict) -> bool:
    return (
        operation.get("operation_type") == "расход"
        and str(operation.get("expense_category") or "").strip() in config.COMMERCIAL_EXPENSE_CATEGORIES
    )


def _is_nonop_expense(operation: dict) -> bool:
    return operation.get("operation_type") == "расход" and not _is_commercial_expense(operation)


def _selected_operations(month_operations_map: dict[str, list[dict]], selected_period: str) -> list[dict]:
    month_keys = sorted(month_operations_map)
    if selected_period and selected_period != "Все" and selected_period in month_operations_map:
        return list(month_operations_map[selected_period])
    return [item for month in month_keys for item in month_operations_map[month]]


def build_operations_register_rows(operations: list[dict]) -> list[list]:
    rows = [[
        "ID",
        "Дата",
        "Тип",
        "Блок",
        "Категория",
        "Подкатегория",
        "Описание",
        "Сумма",
        "Счет",
        "Поставщик",
        "Клиент",
        "№ заказа",
        "Канал",
        "Комментарий",
    ]]

    for operation in _sorted_operations(operations):
        op_type = operation.get("operation_type")
        if _is_revenue_operation(operation):
            block = "Доход"
        elif _is_purchase_operation(operation):
            block = "Себестоимость"
        elif _is_commercial_expense(operation):
            block = "Коммерческие"
        elif _is_nonop_expense(operation):
            block = "Внереализационные"
        else:
            block = ""
        rows.append([
            operation.get("id"),
            operation.get("date"),
            op_type,
            block,
            operation.get("expense_category"),
            operation.get("expense_subcategory"),
            operation.get("description"),
            operation.get("amount"),
            operation.get("payment_account"),
            operation.get("supplier"),
            operation.get("client_name"),
            operation.get("order_phone"),
            operation.get("income_channel"),
            operation.get("comment"),
        ])

    if len(rows) == 1:
        rows.append(["", "", "", "", "", "", "Нет данных", 0.0, "", "", "", "", "", ""])
    return rows


def build_pl_rows(month_operations_map: dict[str, list[dict]], selected_period: str = "Все") -> list[list]:
    month_keys = sorted(month_operations_map)
    target_months = _pick_dashboard_months(month_keys, selected_period)
    if not target_months:
        target_months = month_keys

    all_operations = [op for month in month_keys for op in month_operations_map[month]]
    cogs_by_order = _build_order_cogs_map(all_operations)
    metrics = {
        "Выручка": [],
        "Себестоимость": [],
        "Валовая прибыль": [],
        "Коммерческие расходы": [],
        "Внереализационные расходы": [],
        "Чистая прибыль": [],
        "Маржа %": [],
    }

    for month in target_months:
        operations = month_operations_map.get(month, [])
        revenue = sum(op["amount"] for op in operations if _is_revenue_operation(op))
        sold_order_ids = {
            int(op["order_id"])
            for op in operations
            if _is_sale_recognition_operation(op) and op.get("order_id")
        }
        cogs = sum(cogs_by_order.get(order_id, 0.0) for order_id in sold_order_ids)
        gross = revenue - cogs
        commercial = sum(op["amount"] for op in operations if _is_commercial_expense(op))
        nonop = sum(op["amount"] for op in operations if _is_nonop_expense(op))
        net = gross - commercial - nonop
        margin_pct = (gross / revenue * 100.0) if revenue > 0 else 0.0

        metrics["Выручка"].append(revenue)
        metrics["Себестоимость"].append(cogs)
        metrics["Валовая прибыль"].append(gross)
        metrics["Коммерческие расходы"].append(commercial)
        metrics["Внереализационные расходы"].append(nonop)
        metrics["Чистая прибыль"].append(net)
        metrics["Маржа %"].append(round(margin_pct, 2))

    rows = [["Показатель", *target_months, "Итого"]]
    total_revenue = sum(metrics["Выручка"])
    total_gross = sum(metrics["Валовая прибыль"])
    weighted_margin_pct = (total_gross / total_revenue * 100.0) if total_revenue > 0 else 0.0

    for title, values in metrics.items():
        if title == "Маржа %":
            total = round(weighted_margin_pct, 2)
        else:
            total = sum(values)
        rows.append([title, *values, total])
    return rows


def build_cashflow_rows(month_operations_map: dict[str, list[dict]], selected_period: str = "Все") -> list[list]:
    operations = _selected_operations(month_operations_map, selected_period)
    by_account: dict[str, dict[str, float]] = defaultdict(lambda: {"in": 0.0, "out": 0.0})
    for op in _sorted_operations(operations):
        account = op.get("payment_account") or "Не указан"
        if _is_cash_in_operation(op):
            by_account[account]["in"] += op["amount"]
        elif op.get("operation_type") in {"закупка", "расход"} and not _is_spec_aggregate_operation(op):
            by_account[account]["out"] += op["amount"]

    rows = [["Счет", "Приход", "Расход", "Чистый поток"]]
    total_in = total_out = 0.0
    for account, values in sorted(by_account.items(), key=lambda item: item[0]):
        net = values["in"] - values["out"]
        total_in += values["in"]
        total_out += values["out"]
        rows.append([account, values["in"], values["out"], net])
    rows.append(["Итого", total_in, total_out, total_in - total_out])
    if len(rows) == 2:
        rows.insert(1, ["Нет данных", 0.0, 0.0, 0.0])
    return rows


def build_plan_fact_rows(
    month_operations_map: dict[str, list[dict]],
    budget_plan_map: dict[str, dict[str, float]],
) -> list[list]:
    month_keys = sorted(month_operations_map)
    rows = [[
        "Месяц",
        "План чистой прибыли",
        "Факт чистой прибыли",
        "Отклонение",
        "Отклонение %",
        "Выручка факт",
        "Себестоимость факт",
        "Коммерческие расходы факт",
        "Внереализационные расходы факт",
    ]]
    all_operations = [op for month in month_keys for op in month_operations_map.get(month, [])]
    cogs_by_order = _build_order_cogs_map(all_operations)

    for month_key in month_keys:
        operations = month_operations_map.get(month_key, [])
        revenue = sum(op["amount"] for op in operations if _is_revenue_operation(op))
        sold_order_ids = {
            int(op["order_id"])
            for op in operations
            if _is_sale_recognition_operation(op) and op.get("order_id")
        }
        cogs = sum(cogs_by_order.get(order_id, 0.0) for order_id in sold_order_ids)
        commercial = sum(op["amount"] for op in operations if _is_commercial_expense(op))
        nonop = sum(op["amount"] for op in operations if _is_nonop_expense(op))
        fact_net = revenue - cogs - commercial - nonop
        plan_net = float(budget_plan_map.get(month_key, {}).get("net", 0.0))
        diff = fact_net - plan_net
        diff_pct = (diff / abs(plan_net) * 100.0) if plan_net else 0.0
        rows.append([month_key, plan_net, fact_net, diff, round(diff_pct, 2), revenue, cogs, commercial, nonop])

    if len(rows) == 1:
        rows.append(["Нет данных", 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    return rows


def build_unit_economics_rows(operations: list[dict]) -> list[list]:
    by_order: dict[int, list[dict]] = defaultdict(list)
    for operation in _sorted_operations(operations):
        order_id = operation.get("order_id")
        if order_id:
            by_order[int(order_id)].append(operation)

    rows = [[
        "Order ID",
        "Телефон заказа",
        "Клиент",
        "Продажи",
        "Себестоимость",
        "Валовая прибыль",
        "Маржа %",
        "Коммерческие расходы",
        "Внереализационные расходы",
        "Чистая прибыль",
        "Операций",
    ]]

    for order_id, order_ops in sorted(by_order.items(), key=lambda item: item[0]):
        revenue = sum(op["amount"] for op in order_ops if _is_revenue_operation(op))
        cogs = sum(op["amount"] for op in order_ops if _is_purchase_operation(op))
        gross = revenue - cogs
        commercial = sum(op["amount"] for op in order_ops if _is_commercial_expense(op))
        nonop = sum(op["amount"] for op in order_ops if _is_nonop_expense(op))
        net = gross - commercial - nonop
        margin_pct = (gross / revenue * 100.0) if revenue > 0 else 0.0

        reference = order_ops[-1]
        rows.append([
            order_id,
            reference.get("order_phone"),
            reference.get("client_name"),
            revenue,
            cogs,
            gross,
            round(margin_pct, 2),
            commercial,
            nonop,
            net,
            len(order_ops),
        ])

    if len(rows) == 1:
        rows.append(["", "", "", 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0])
    return rows


def build_data_quality_rows(operations: list[dict]) -> list[list]:
    issues: list[dict] = []
    for operation in _sorted_operations(operations):
        op_type = str(operation.get("operation_type") or "").strip().lower()
        amount = float(operation.get("amount") or 0.0)
        date_value = str(operation.get("date") or "").strip()
        account = str(operation.get("payment_account") or "").strip()
        source_system = str(operation.get("source_system") or "").strip().lower()
        issue_messages: list[str] = []

        if amount <= 0:
            issue_messages.append("Сумма <= 0")
        if not _looks_like_iso_date(date_value):
            issue_messages.append("Некорректная дата")
        if not account:
            issue_messages.append("Не указан счет оплаты")
        if op_type == "расход":
            if not str(operation.get("expense_category") or "").strip():
                issue_messages.append("Нет категории расхода")
            if source_system != "miniapp" and not str(operation.get("expense_subcategory") or "").strip():
                issue_messages.append("Нет подкатегории расхода")
        if op_type in {"продажа", "закупка"} and not (
            str(operation.get("order_phone") or "").strip() or operation.get("order_id")
        ):
            issue_messages.append("Нет привязки к заказу")

        normalized_account = config.normalize_payment_account(account)
        if account and not normalized_account:
            issue_messages.append("Счет не из справочника")

        for extra_issue in operation.get("review_flags") or []:
            message = str(extra_issue or "").strip()
            if message:
                issue_messages.append(message)

        for message in issue_messages:
            issues.append(
                {
                    "id": operation.get("id"),
                    "date": date_value,
                    "op_type": op_type,
                    "description": operation.get("description"),
                    "amount": amount,
                    "account": account,
                    "created_by": operation.get("created_by"),
                    "issue": message,
                }
            )

    issue_counts: dict[str, int] = defaultdict(int)
    for issue in issues:
        issue_counts[str(issue["issue"])] += 1

    rows: list[list] = [
        ["Контроль качества данных", "Значение", "Статус", "Комментарий"],
        ["Операций в реестре", len(operations), "OK", ""],
        ["Проблемных записей", len(issues), "OK" if not issues else "Проблема", ""],
    ]

    for issue_name, count in sorted(issue_counts.items(), key=lambda item: (-item[1], item[0])):
        rows.append([issue_name, count, "Проблема", "Требует исправления"])

    rows.append([""])
    rows.append(["ID", "Дата", "Тип", "Описание", "Сумма", "Счет", "Проблема", "Создал"])
    if not issues:
        rows.append(["", "", "", "Нет проблем", 0.0, "", "OK", ""])
    else:
        for issue in issues:
            rows.append(
                [
                    issue["id"],
                    issue["date"],
                    issue["op_type"],
                    issue["description"],
                    issue["amount"],
                    issue["account"],
                    issue["issue"],
                    issue["created_by"],
                ]
            )
    return rows


def build_specs_rows(spec_items: list[dict]) -> list[list]:
    rows = [[
        "Spec ID",
        "Версия",
        "Дата",
        "Order ID",
        "Телефон заказа",
        "Клиент",
        "Позиция",
        "Компонент",
        "Значение",
        "Закупка",
        "Статус позиции",
        "Уверенность",
        "Статус спецификации",
        "Файл",
    ]]
    for row in spec_items:
        rows.append(
            [
                row.get("spec_document_id"),
                row.get("version"),
                row.get("spec_created_at"),
                row.get("order_id"),
                row.get("order_phone") or row.get("client_phone"),
                row.get("client_name"),
                row.get("item_index"),
                row.get("component_name"),
                row.get("component_value"),
                row.get("purchase_price"),
                row.get("item_status"),
                row.get("confidence"),
                row.get("parse_status"),
                row.get("source_file_name"),
            ]
        )
    if len(rows) == 1:
        rows.append(["", "", "", "", "", "", "", "Нет данных", "", "", "", "", "", ""])
    return rows


def build_specs_review_rows(spec_items: list[dict]) -> list[list]:
    rows = [[
        "Spec ID",
        "Версия",
        "Дата",
        "Order ID",
        "Телефон заказа",
        "Клиент",
        "Позиция",
        "Компонент",
        "Значение",
        "Закупка",
        "Статус позиции",
        "Уверенность",
        "Статус спецификации",
        "Файл",
        "Причина",
    ]]
    for row in spec_items:
        rows.append(
            [
                row.get("spec_document_id"),
                row.get("version"),
                row.get("spec_created_at"),
                row.get("order_id"),
                row.get("order_phone") or row.get("client_phone"),
                row.get("client_name"),
                row.get("item_index"),
                row.get("component_name"),
                row.get("component_value"),
                row.get("purchase_price"),
                row.get("item_status"),
                row.get("confidence"),
                row.get("parse_status"),
                row.get("source_file_name"),
                "Повторная версия спецификации (ручная проверка)",
            ]
        )
    if len(rows) == 1:
        rows.append(["", "", "", "", "", "", "", "Нет данных", "", "", "", "", "", "", ""])
    return rows


def _pick_dashboard_months(month_keys: list[str], selected_period: str | None) -> list[str]:
    selected = str(selected_period or "").strip()
    if selected and selected != "Все" and selected in month_keys:
        return [selected]
    return month_keys


def build_dashboard_rows(
    month_operations_map: dict[str, list[dict]],
    budget_plan_map: dict[str, dict[str, float]],
    selected_period: str = "Все",
) -> tuple[list[list], list[str], dict[str, int]]:
    all_months = sorted(month_operations_map)
    dashboard_months = _pick_dashboard_months(all_months, selected_period=selected_period)

    rows: list[list] = []
    metrics = {
        "dds_in": ("ДДС", "Приход"),
        "dds_out": ("ДДС", "Расход"),
        "dds_net": ("ДДС", "Чистый поток"),
        "opiu_revenue": ("ОПиУ", "Выручка"),
        "opiu_cogs": ("ОПиУ", "Себестоимость"),
        "opiu_gross": ("ОПиУ", "Валовая прибыль"),
        "opiu_commercial": ("ОПиУ", "Коммерческие расходы"),
        "opiu_nonop": ("ОПиУ", "Внереализационные расходы"),
        "opiu_net": ("ОПиУ", "Чистая прибыль"),
        "budget_plan_net": ("Бюджет", "План чистой прибыли"),
        "budget_fact_net": ("Бюджет", "Факт чистой прибыли"),
    }
    values_by_metric: dict[str, list[float]] = {key: [] for key in metrics}
    all_operations = [op for month in all_months for op in month_operations_map.get(month, [])]
    cogs_by_order = _build_order_cogs_map(all_operations)

    for month in dashboard_months:
        operations = month_operations_map[month]
        revenue = sum(operation["amount"] for operation in operations if _is_revenue_operation(operation))
        sold_order_ids = {
            int(operation["order_id"])
            for operation in operations
            if _is_sale_recognition_operation(operation) and operation.get("order_id")
        }
        cogs = sum(cogs_by_order.get(order_id, 0.0) for order_id in sold_order_ids)
        commercial = sum(operation["amount"] for operation in operations if _is_commercial_expense(operation))
        nonop = sum(operation["amount"] for operation in operations if _is_nonop_expense(operation))
        opex = commercial + nonop
        incoming = sum(operation["amount"] for operation in operations if _is_cash_in_operation(operation))
        outgoing = cogs + opex
        net = revenue - cogs - opex
        plan = budget_plan_map.get(month, {})

        values_by_metric["dds_in"].append(incoming)
        values_by_metric["dds_out"].append(outgoing)
        values_by_metric["dds_net"].append(incoming - outgoing)
        values_by_metric["opiu_revenue"].append(revenue)
        values_by_metric["opiu_cogs"].append(cogs)
        values_by_metric["opiu_gross"].append(revenue - cogs)
        values_by_metric["opiu_commercial"].append(commercial)
        values_by_metric["opiu_nonop"].append(nonop)
        values_by_metric["opiu_net"].append(net)
        values_by_metric["budget_plan_net"].append(plan.get("net", 0.0))
        values_by_metric["budget_fact_net"].append(net)

    total_revenue = sum(values_by_metric["opiu_revenue"])
    total_gross = sum(values_by_metric["opiu_gross"])
    total_net = sum(values_by_metric["opiu_net"])
    total_dds_net = sum(values_by_metric["dds_net"])
    margin_pct = (total_gross / total_revenue * 100.0) if total_revenue else 0.0

    rows.append(
        [
            "Dashboard",
            "Период",
            selected_period or "Все",
            "Валовая прибыль",
            total_gross,
            "Маржа %",
            round(margin_pct, 2),
            "Чистая прибыль",
            total_net,
            "ДДС чистый поток",
            total_dds_net,
        ]
    )
    rows.append([""])
    headers = ["Блок", "Показатель", *dashboard_months, "Итого"]
    rows.append(headers)

    metric_row_map: dict[str, int] = {}
    for metric_key, (block, title) in metrics.items():
        values = values_by_metric[metric_key]
        metric_row_map[metric_key] = len(rows)
        rows.append([block, title, *values, sum(values)])
    return rows, dashboard_months, metric_row_map


def build_print_rows(
    month_operations_map: dict[str, list[dict]],
    budget_plan_map: dict[str, dict[str, float]],
    period_value: str = "Все",
) -> list[list]:
    all_months = sorted(month_operations_map)
    months = _pick_dashboard_months(all_months, period_value)
    selected_operations = [op for month in months for op in month_operations_map.get(month, [])]
    cogs_by_order = _build_order_cogs_map(selected_operations)
    revenue = opex = 0.0
    sold_order_ids: set[int] = set()
    for month in months:
        operations = month_operations_map.get(month, [])
        revenue += sum(
            operation["amount"]
            for operation in operations
            if _is_revenue_operation(operation)
        )
        sold_order_ids.update(
            int(operation["order_id"])
            for operation in operations
            if _is_sale_recognition_operation(operation) and operation.get("order_id")
        )
        opex += sum(operation["amount"] for operation in operations if operation["operation_type"] == "расход")
    cogs = sum(cogs_by_order.get(order_id, 0.0) for order_id in sold_order_ids)

    gross = revenue - cogs
    net = gross - opex
    plan_net = sum(budget_plan_map.get(month, {}).get("net", 0.0) for month in months)

    period_label = ", ".join(months) if months else "Нет данных"
    return [
        ["CONSTRUCT PC", "", "", ""],
        ["Печатный управленческий отчет", "", "", ""],
        [f"Период: {period_label}", "", "", ""],
        [f"Сформирован: {datetime.now().strftime('%Y-%m-%d %H:%M')}", "", "", ""],
        [""],
        ["Показатель", "Сумма"],
        ["Выручка", revenue],
        ["Себестоимость", cogs],
        ["Валовая прибыль", gross],
        ["Оперрасходы", opex],
        ["Чистая прибыль", net],
        ["План чистой прибыли", plan_net],
        ["Отклонение факт-план", net - plan_net],
        [""],
        ["Ответственный", "_________________________"],
        ["Подпись", "_________________________"],
    ]


def _resolve_spreadsheet_id() -> str:
    if config.SPREADSHEET_ID:
        return config.SPREADSHEET_ID
    if SPREADSHEET_ID_FILE.exists():
        return SPREADSHEET_ID_FILE.read_text(encoding="utf-8").strip()
    return ""


def _persist_spreadsheet_id(spreadsheet_id: str):
    SPREADSHEET_ID_FILE.parent.mkdir(parents=True, exist_ok=True)
    SPREADSHEET_ID_FILE.write_text(spreadsheet_id, encoding="utf-8")


def _open_client() -> gspread.Client:
    creds_path = Path(config.GOOGLE_CREDS_PATH)
    if not creds_path.exists():
        raise FileNotFoundError(f"Google credentials file not found: {creds_path}")
    # Force-disable local/system proxies for Google auth + Sheets calls.
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(key, None)
    os.environ["NO_PROXY"] = "*"
    return gspread.service_account(
        filename=str(creds_path),
        http_client=NoProxyHTTPClient,
    )


def _open_or_create_spreadsheet(gc: gspread.Client) -> tuple[gspread.Spreadsheet, bool]:
    spreadsheet_id = _resolve_spreadsheet_id()
    if spreadsheet_id:
        return gc.open_by_key(spreadsheet_id), False

    spreadsheet = gc.create(config.SPREADSHEET_TITLE)
    _persist_spreadsheet_id(spreadsheet.id)
    if config.SPREADSHEET_SHARE_EMAIL:
        try:
            spreadsheet.share(config.SPREADSHEET_SHARE_EMAIL, perm_type="user", role="writer")
        except Exception:
            logger.warning("Could not share spreadsheet with %s", config.SPREADSHEET_SHARE_EMAIL, exc_info=True)
    return spreadsheet, True


def _ensure_worksheet(
    spreadsheet: gspread.Spreadsheet,
    title: str,
    rows: int = 1000,
    cols: int = 20,
) -> gspread.Worksheet:
    try:
        return spreadsheet.worksheet(title)
    except gspread.exceptions.WorksheetNotFound:
        pass

    if len(spreadsheet.worksheets()) == 1 and spreadsheet.sheet1.title in {"Sheet1", "Лист1"}:
        worksheet = spreadsheet.sheet1
        worksheet.update_title(title)
        worksheet.resize(rows=rows, cols=cols)
        return worksheet
    return spreadsheet.add_worksheet(title=title, rows=rows, cols=cols)


def _replace_sheet_contents(worksheet: gspread.Worksheet, rows: list[list], min_rows: int = 50, min_cols: int = 10):
    row_count = max(len(rows) + 5, min_rows)
    col_count = max(max((len(row) for row in rows), default=1), min_cols)
    worksheet.clear()
    worksheet.resize(rows=row_count, cols=col_count)
    worksheet.update("A1", rows, value_input_option="USER_ENTERED")


def _sheet_has_user_data(worksheet: gspread.Worksheet) -> bool:
    values = worksheet.get_all_values()
    return len(values) > 1 and any(any(cell.strip() for cell in row) for row in values[1:])


def _rgb(r: int, g: int, b: int) -> dict:
    return {"red": r / 255, "green": g / 255, "blue": b / 255}


def _apply_sheet_style(
    spreadsheet: gspread.Spreadsheet,
    worksheet: gspread.Worksheet,
    rows: list[list],
    header_color: dict,
    header_text_color: dict | None = None,
    money_columns: list[int] | None = None,
    percent_columns: list[int] | None = None,
    section_row_colors: list[tuple[int, int, dict]] | None = None,
):
    sheet_id = worksheet.id
    row_count = max(len(rows), 2)
    col_count = max(max((len(row) for row in rows), default=1), 1)

    requests: list[dict] = [
        {
            "updateSheetProperties": {
                "properties": {"sheetId": sheet_id, "gridProperties": {"frozenRowCount": 1}},
                "fields": "gridProperties.frozenRowCount",
            }
        },
        {
            "repeatCell": {
                "range": {"sheetId": sheet_id, "startRowIndex": 0, "endRowIndex": 1},
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": header_color,
                        "textFormat": {
                            "bold": True,
                            "foregroundColor": header_text_color or _rgb(33, 37, 41),
                            "fontSize": 10,
                        },
                        "horizontalAlignment": "CENTER",
                        "verticalAlignment": "MIDDLE",
                        "wrapStrategy": "WRAP",
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
            }
        },
        {
            "repeatCell": {
                "range": {"sheetId": sheet_id, "startRowIndex": 1, "endRowIndex": row_count},
                "cell": {
                    "userEnteredFormat": {
                        "textFormat": {"fontSize": 10},
                        "verticalAlignment": "MIDDLE",
                        "wrapStrategy": "WRAP",
                    }
                },
                "fields": "userEnteredFormat(textFormat,verticalAlignment,wrapStrategy)",
            }
        },
        {
            "autoResizeDimensions": {
                "dimensions": {
                    "sheetId": sheet_id,
                    "dimension": "COLUMNS",
                    "startIndex": 0,
                    "endIndex": col_count,
                }
            }
        },
    ]

    for col_index in money_columns or []:
        requests.append(
            {
                "repeatCell": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": row_count,
                        "startColumnIndex": col_index,
                        "endColumnIndex": col_index + 1,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "numberFormat": {"type": "NUMBER", "pattern": "#,##0 \"₽\""},
                            "horizontalAlignment": "RIGHT",
                        }
                    },
                    "fields": "userEnteredFormat(numberFormat,horizontalAlignment)",
                }
            }
        )

    for col_index in percent_columns or []:
        requests.append(
            {
                "repeatCell": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": row_count,
                        "startColumnIndex": col_index,
                        "endColumnIndex": col_index + 1,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "numberFormat": {"type": "NUMBER", "pattern": "0.00\"%\""},
                            "horizontalAlignment": "RIGHT",
                        }
                    },
                    "fields": "userEnteredFormat(numberFormat,horizontalAlignment)",
                }
            }
        )

    for start_row, end_row, color in section_row_colors or []:
        requests.append(
            {
                "repeatCell": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": max(start_row - 1, 1),
                        "endRowIndex": min(end_row, row_count),
                    },
                    "cell": {"userEnteredFormat": {"backgroundColor": color}},
                    "fields": "userEnteredFormat.backgroundColor",
                }
            }
        )

    try:
        spreadsheet.batch_update({"requests": requests})
    except Exception:
        logger.warning("Could not style sheet %s", worksheet.title, exc_info=True)


def _apply_row_number_format(
    spreadsheet: gspread.Spreadsheet,
    worksheet: gspread.Worksheet,
    *,
    row_index_one_based: int,
    start_column_index: int,
    end_column_index: int,
    pattern: str,
):
    if row_index_one_based <= 1 or start_column_index >= end_column_index:
        return
    request = {
        "repeatCell": {
            "range": {
                "sheetId": worksheet.id,
                "startRowIndex": row_index_one_based - 1,
                "endRowIndex": row_index_one_based,
                "startColumnIndex": start_column_index,
                "endColumnIndex": end_column_index,
            },
            "cell": {
                "userEnteredFormat": {
                    "numberFormat": {"type": "NUMBER", "pattern": pattern},
                    "horizontalAlignment": "RIGHT",
                }
            },
            "fields": "userEnteredFormat(numberFormat,horizontalAlignment)",
        }
    }
    try:
        spreadsheet.batch_update({"requests": [request]})
    except Exception:
        logger.warning("Could not apply row number format on sheet %s", worksheet.title, exc_info=True)


def _replace_conditional_format_rules(
    spreadsheet: gspread.Spreadsheet,
    worksheet: gspread.Worksheet,
    rules: list[dict],
):
    try:
        metadata = spreadsheet.fetch_sheet_metadata(params={"includeGridData": "false"})
    except Exception:
        logger.warning("Could not fetch sheet metadata for conditional rules (%s)", worksheet.title, exc_info=True)
        return

    sheet_meta = next(
        (
            sheet
            for sheet in metadata.get("sheets", [])
            if sheet.get("properties", {}).get("sheetId") == worksheet.id
        ),
        None,
    )
    existing = list((sheet_meta or {}).get("conditionalFormats", []) or [])
    requests: list[dict] = []
    for index in reversed(range(len(existing))):
        requests.append(
            {
                "deleteConditionalFormatRule": {
                    "sheetId": worksheet.id,
                    "index": index,
                }
            }
        )
    for index, rule in enumerate(rules):
        requests.append(
            {
                "addConditionalFormatRule": {
                    "rule": rule,
                    "index": index,
                }
            }
        )
    if not requests:
        return
    try:
        spreadsheet.batch_update({"requests": requests})
    except Exception:
        logger.warning("Could not replace conditional rules on sheet %s", worksheet.title, exc_info=True)


def _numeric_pos_neg_rules(
    *,
    sheet_id: int,
    start_row_index: int,
    end_row_index: int,
    start_col_index: int,
    end_col_index: int,
    positive_color: dict | None = None,
    negative_color: dict | None = None,
) -> list[dict]:
    if end_row_index <= start_row_index or end_col_index <= start_col_index:
        return []
    target_range = {
        "sheetId": sheet_id,
        "startRowIndex": start_row_index,
        "endRowIndex": end_row_index,
        "startColumnIndex": start_col_index,
        "endColumnIndex": end_col_index,
    }
    return [
        {
            "ranges": [target_range],
            "booleanRule": {
                "condition": {"type": "NUMBER_GREATER", "values": [{"userEnteredValue": "0"}]},
                "format": {
                    "backgroundColor": positive_color or _rgb(232, 245, 233),
                    "textFormat": {"foregroundColor": _rgb(27, 94, 32), "bold": True},
                },
            },
        },
        {
            "ranges": [target_range],
            "booleanRule": {
                "condition": {"type": "NUMBER_LESS", "values": [{"userEnteredValue": "0"}]},
                "format": {
                    "backgroundColor": negative_color or _rgb(255, 235, 238),
                    "textFormat": {"foregroundColor": _rgb(183, 28, 28), "bold": True},
                },
            },
        },
    ]


def _dashboard_chart_requests(
    sheet_id: int,
    month_count: int,
    metric_row_map: dict[str, int],
    domain_row_index: int = 2,
    start_row_offset: int = 13,
) -> list[dict]:
    if month_count <= 0:
        return []

    month_start_col = 2
    month_end_col = month_start_col + month_count
    domain = {
        "sourceRange": {
            "sources": [
                {
                    "sheetId": sheet_id,
                    "startRowIndex": domain_row_index,
                    "endRowIndex": domain_row_index + 1,
                    "startColumnIndex": month_start_col,
                    "endColumnIndex": month_end_col,
                }
            ]
        }
    }

    revenue_row = metric_row_map.get("opiu_revenue", 0)
    cogs_row = metric_row_map.get("opiu_cogs", 0)
    net_row = metric_row_map.get("opiu_net", 0)
    plan_row = metric_row_map.get("budget_plan_net", 0)
    fact_row = metric_row_map.get("budget_fact_net", 0)

    return [
        {
            "addChart": {
                "chart": {
                    "spec": {
                        "title": "Выручка / Себестоимость / Чистая прибыль",
                        "basicChart": {
                            "chartType": "COLUMN",
                            "legendPosition": "BOTTOM_LEGEND",
                            "axis": [
                                {"position": "BOTTOM_AXIS", "title": "Месяц"},
                                {"position": "LEFT_AXIS", "title": "₽"},
                            ],
                            "domains": [{"domain": domain}],
                            "series": [
                                {
                                    "series": {
                                        "sourceRange": {
                                            "sources": [
                                                {
                                                    "sheetId": sheet_id,
                                                    "startRowIndex": revenue_row,
                                                    "endRowIndex": revenue_row + 1,
                                                    "startColumnIndex": month_start_col,
                                                    "endColumnIndex": month_end_col,
                                                }
                                            ]
                                        }
                                    },
                                    "targetAxis": "LEFT_AXIS",
                                },
                                {
                                    "series": {
                                        "sourceRange": {
                                            "sources": [
                                                {
                                                    "sheetId": sheet_id,
                                                    "startRowIndex": cogs_row,
                                                    "endRowIndex": cogs_row + 1,
                                                    "startColumnIndex": month_start_col,
                                                    "endColumnIndex": month_end_col,
                                                }
                                            ]
                                        }
                                    },
                                    "targetAxis": "LEFT_AXIS",
                                },
                                {
                                    "series": {
                                        "sourceRange": {
                                            "sources": [
                                                {
                                                    "sheetId": sheet_id,
                                                    "startRowIndex": net_row,
                                                    "endRowIndex": net_row + 1,
                                                    "startColumnIndex": month_start_col,
                                                    "endColumnIndex": month_end_col,
                                                }
                                            ]
                                        }
                                    },
                                    "targetAxis": "LEFT_AXIS",
                                },
                            ],
                            "headerCount": 1,
                        },
                    },
                    "position": {
                        "overlayPosition": {
                            "anchorCell": {
                                "sheetId": sheet_id,
                                "rowIndex": start_row_offset,
                                "columnIndex": 0,
                            },
                            "widthPixels": 860,
                            "heightPixels": 280,
                        }
                    },
                }
            }
        },
        {
            "addChart": {
                "chart": {
                    "spec": {
                        "title": "Бюджет: план vs факт чистой прибыли",
                        "basicChart": {
                            "chartType": "LINE",
                            "legendPosition": "BOTTOM_LEGEND",
                            "axis": [
                                {"position": "BOTTOM_AXIS", "title": "Месяц"},
                                {"position": "LEFT_AXIS", "title": "₽"},
                            ],
                            "domains": [{"domain": domain}],
                            "series": [
                                {
                                    "series": {
                                        "sourceRange": {
                                            "sources": [
                                                {
                                                    "sheetId": sheet_id,
                                                    "startRowIndex": plan_row,
                                                    "endRowIndex": plan_row + 1,
                                                    "startColumnIndex": month_start_col,
                                                    "endColumnIndex": month_end_col,
                                                }
                                            ]
                                        }
                                    },
                                    "targetAxis": "LEFT_AXIS",
                                },
                                {
                                    "series": {
                                        "sourceRange": {
                                            "sources": [
                                                {
                                                    "sheetId": sheet_id,
                                                    "startRowIndex": fact_row,
                                                    "endRowIndex": fact_row + 1,
                                                    "startColumnIndex": month_start_col,
                                                    "endColumnIndex": month_end_col,
                                                }
                                            ]
                                        }
                                    },
                                    "targetAxis": "LEFT_AXIS",
                                },
                            ],
                            "headerCount": 1,
                        },
                    },
                    "position": {
                        "overlayPosition": {
                            "anchorCell": {
                                "sheetId": sheet_id,
                                "rowIndex": start_row_offset + 20,
                                "columnIndex": 0,
                            },
                            "widthPixels": 860,
                            "heightPixels": 280,
                        }
                    },
                }
            }
        },
    ]


def _refresh_dashboard_charts(
    spreadsheet: gspread.Spreadsheet,
    dashboard_ws: gspread.Worksheet,
    month_count: int,
    metric_row_map: dict[str, int],
):
    if month_count <= 0:
        return

    requests: list[dict] = []
    try:
        metadata = spreadsheet.fetch_sheet_metadata(params={"includeGridData": "false"})
        dashboard_sheet = next(
            (
                sheet
                for sheet in metadata.get("sheets", [])
                if sheet.get("properties", {}).get("sheetId") == dashboard_ws.id
            ),
            None,
        )
        for chart in (dashboard_sheet or {}).get("charts", []) or []:
            chart_id = chart.get("chartId")
            if chart_id:
                requests.append({"deleteEmbeddedObject": {"objectId": chart_id}})
    except Exception:
        logger.warning("Could not fetch existing dashboard charts metadata", exc_info=True)

    requests.extend(
        _dashboard_chart_requests(
            dashboard_ws.id,
            month_count,
            metric_row_map=metric_row_map,
            domain_row_index=2,
        )
    )
    if not requests:
        return
    try:
        spreadsheet.batch_update({"requests": requests})
    except Exception:
        logger.warning("Could not refresh dashboard charts", exc_info=True)


def _current_dashboard_period(worksheet: gspread.Worksheet, month_keys: list[str]) -> str:
    try:
        value = str(worksheet.acell("C1").value or "").strip()
    except Exception:
        value = ""
    options = {"Все", *month_keys}
    if value in options:
        return value
    current_month = datetime.now().strftime("%Y-%m")
    if current_month in month_keys:
        return current_month
    if month_keys:
        return month_keys[-1]
    return "Все"


def _apply_dashboard_controls(
    spreadsheet: gspread.Spreadsheet,
    worksheet: gspread.Worksheet,
    month_keys: list[str],
    selected_period: str,
):
    options = ["Все", *month_keys]
    requests = [
        {
            "setDataValidation": {
                "range": {
                    "sheetId": worksheet.id,
                    "startRowIndex": 0,
                    "endRowIndex": 1,
                    "startColumnIndex": 2,
                    "endColumnIndex": 3,
                },
                "rule": {
                    "condition": {
                        "type": "ONE_OF_LIST",
                        "values": [{"userEnteredValue": item} for item in options[:500]],
                    },
                    "showCustomUi": True,
                    "strict": True,
                },
            }
        }
    ]
    try:
        spreadsheet.batch_update({"requests": requests})
        worksheet.update("A1:C1", [["Dashboard", "Период", selected_period]], value_input_option="USER_ENTERED")
    except Exception:
        logger.warning("Could not apply dashboard controls", exc_info=True)


def _cleanup_obsolete_sheets(spreadsheet: gspread.Spreadsheet, allowed_titles: set[str]):
    try:
        worksheets = spreadsheet.worksheets()
    except Exception:
        logger.warning("Could not list worksheets for cleanup", exc_info=True)
        return

    for worksheet in worksheets:
        if worksheet.title in allowed_titles:
            continue
        try:
            # Keep at least one sheet in workbook.
            if len(spreadsheet.worksheets()) <= 1:
                break
            spreadsheet.del_worksheet(worksheet)
        except Exception:
            logger.warning("Could not delete obsolete worksheet %s", worksheet.title, exc_info=True)


def _sync_management_workbook(
    operations: list[dict],
    _spec_items: list[dict] | None = None,
    force_reset: bool = False,
) -> dict:
    gc = _open_client()
    spreadsheet, created = _open_or_create_spreadsheet(gc)

    normalized_operations = _sorted_operations(operations)
    month_keys = sorted({_month_key(item.get("date")) for item in normalized_operations if _month_key(item.get("date"))})
    if not month_keys:
        month_keys = [datetime.now().strftime("%Y-%m")]

    month_operations_map: dict[str, list[dict]] = {
        month_key: [item for item in normalized_operations if _month_key(item.get("date")) == month_key]
        for month_key in month_keys
    }

    budget_plan_ws = _ensure_worksheet(spreadsheet, BUDGET_PLAN_SHEET, rows=200, cols=8)
    if force_reset or not _sheet_has_user_data(budget_plan_ws):
        _replace_sheet_contents(
            budget_plan_ws,
            build_budget_plan_seed_rows(month_keys),
            min_rows=200,
            min_cols=8,
        )
    budget_plan_values = budget_plan_ws.get_all_values()
    budget_plan_rows = budget_plan_values or build_budget_plan_seed_rows(month_keys)
    budget_plan_map = parse_budget_plan_rows(budget_plan_rows)
    _apply_sheet_style(
        spreadsheet,
        budget_plan_ws,
        budget_plan_rows,
        header_color=_rgb(228, 236, 247),
        money_columns=[1, 2, 3, 4, 5],
    )

    dashboard_ws = _ensure_worksheet(spreadsheet, DASHBOARD_SHEET, rows=280, cols=40)
    selected_period = _current_dashboard_period(dashboard_ws, month_keys)

    register_ws = _ensure_worksheet(spreadsheet, OPERATIONS_REGISTER_SHEET, rows=3000, cols=20)
    register_rows = build_operations_register_rows(normalized_operations)
    _replace_sheet_contents(register_ws, register_rows, min_rows=500, min_cols=14)
    _apply_sheet_style(
        spreadsheet,
        register_ws,
        register_rows,
        header_color=_rgb(225, 236, 248),
        money_columns=[7],
    )

    pl_ws = _ensure_worksheet(spreadsheet, PL_SHEET, rows=240, cols=24)
    pl_rows = build_pl_rows(month_operations_map, selected_period=selected_period)
    _replace_sheet_contents(pl_ws, pl_rows, min_rows=120, min_cols=max(8, len(pl_rows[0]) + 2))
    _apply_sheet_style(
        spreadsheet,
        pl_ws,
        pl_rows,
        header_color=_rgb(232, 240, 252),
        money_columns=list(range(1, max(len(pl_rows[0]), 2))),
        section_row_colors=[
            (2, 4, _rgb(238, 248, 243)),
            (5, 6, _rgb(255, 248, 233)),
            (7, 8, _rgb(236, 244, 253)),
        ],
    )
    margin_row_index = next(
        (index for index, row in enumerate(pl_rows, start=1) if row and str(row[0]) == "Маржа %"),
        None,
    )
    if margin_row_index:
        _apply_row_number_format(
            spreadsheet,
            pl_ws,
            row_index_one_based=margin_row_index,
            start_column_index=1,
            end_column_index=max(len(pl_rows[0]), 2),
            pattern="0.00\"%\"",
        )

    cashflow_ws = _ensure_worksheet(spreadsheet, CASHFLOW_SHEET, rows=400, cols=10)
    cashflow_rows = build_cashflow_rows(month_operations_map, selected_period=selected_period)
    _replace_sheet_contents(cashflow_ws, cashflow_rows, min_rows=160, min_cols=8)
    _apply_sheet_style(
        spreadsheet,
        cashflow_ws,
        cashflow_rows,
        header_color=_rgb(228, 245, 247),
        money_columns=[1, 2, 3],
    )

    plan_fact_ws = _ensure_worksheet(spreadsheet, PLAN_FACT_SHEET, rows=260, cols=14)
    plan_fact_rows = build_plan_fact_rows(month_operations_map, budget_plan_map)
    _replace_sheet_contents(plan_fact_ws, plan_fact_rows, min_rows=140, min_cols=10)
    _apply_sheet_style(
        spreadsheet,
        plan_fact_ws,
        plan_fact_rows,
        header_color=_rgb(238, 233, 250),
        money_columns=[1, 2, 3, 5, 6, 7, 8],
        percent_columns=[4],
    )

    unit_ws = _ensure_worksheet(spreadsheet, UNIT_ECONOMICS_SHEET, rows=260, cols=16)
    unit_rows = build_unit_economics_rows(normalized_operations)
    _replace_sheet_contents(unit_ws, unit_rows, min_rows=140, min_cols=12)
    _apply_sheet_style(
        spreadsheet,
        unit_ws,
        unit_rows,
        header_color=_rgb(232, 246, 233),
        money_columns=[3, 4, 5, 7, 8, 9],
        percent_columns=[6],
    )

    quality_ws = _ensure_worksheet(spreadsheet, DATA_QUALITY_SHEET, rows=500, cols=12)
    quality_rows = build_data_quality_rows(normalized_operations)
    _replace_sheet_contents(quality_ws, quality_rows, min_rows=220, min_cols=8)
    _apply_sheet_style(
        spreadsheet,
        quality_ws,
        quality_rows,
        header_color=_rgb(255, 244, 224),
        money_columns=[1, 4],
        section_row_colors=[(7, max(8, len(quality_rows)), _rgb(250, 250, 250))],
    )

    dashboard_rows, dashboard_months, metric_row_map = build_dashboard_rows(
        month_operations_map,
        budget_plan_map,
        selected_period=selected_period,
    )
    _replace_sheet_contents(
        dashboard_ws,
        dashboard_rows,
        min_rows=180,
        min_cols=max(8, len(month_keys) + 4),
    )
    _apply_sheet_style(
        spreadsheet,
        dashboard_ws,
        dashboard_rows,
        header_color=_rgb(234, 239, 241),
        money_columns=list(range(2, max((len(row) for row in dashboard_rows), default=3))),
        section_row_colors=[
            (4, 6, _rgb(239, 246, 252)),
            (7, 11, _rgb(238, 248, 243)),
            (12, 13, _rgb(255, 248, 233)),
        ],
    )
    _apply_dashboard_controls(spreadsheet, dashboard_ws, month_keys=month_keys, selected_period=selected_period)
    _refresh_dashboard_charts(
        spreadsheet,
        dashboard_ws,
        month_count=len(dashboard_months),
        metric_row_map=metric_row_map,
    )

    _replace_conditional_format_rules(
        spreadsheet,
        cashflow_ws,
        _numeric_pos_neg_rules(
            sheet_id=cashflow_ws.id,
            start_row_index=1,
            end_row_index=max(len(cashflow_rows), 2),
            start_col_index=3,
            end_col_index=4,
        ),
    )

    _replace_conditional_format_rules(
        spreadsheet,
        plan_fact_ws,
        _numeric_pos_neg_rules(
            sheet_id=plan_fact_ws.id,
            start_row_index=1,
            end_row_index=max(len(plan_fact_rows), 2),
            start_col_index=3,
            end_col_index=4,
        ),
    )

    dashboard_rules: list[dict] = []
    month_col_start = 2
    month_col_end = 2 + max(len(dashboard_months), 1)
    for metric_key in ("dds_net", "opiu_net"):
        metric_row_index = metric_row_map.get(metric_key)
        if metric_row_index is None:
            continue
        dashboard_rules.extend(
            _numeric_pos_neg_rules(
                sheet_id=dashboard_ws.id,
                start_row_index=int(metric_row_index),
                end_row_index=int(metric_row_index) + 1,
                start_col_index=month_col_start,
                end_col_index=month_col_end + 1,
            )
        )
    _replace_conditional_format_rules(spreadsheet, dashboard_ws, dashboard_rules)

    quality_status_range = {
        "sheetId": quality_ws.id,
        "startRowIndex": 1,
        "endRowIndex": max(len(quality_rows), 2),
        "startColumnIndex": 2,
        "endColumnIndex": 3,
    }
    _replace_conditional_format_rules(
        spreadsheet,
        quality_ws,
        [
            {
                "ranges": [quality_status_range],
                "booleanRule": {
                    "condition": {"type": "TEXT_CONTAINS", "values": [{"userEnteredValue": "Проблем"}]},
                    "format": {
                        "backgroundColor": _rgb(255, 235, 238),
                        "textFormat": {"foregroundColor": _rgb(183, 28, 28), "bold": True},
                    },
                },
            },
            {
                "ranges": [quality_status_range],
                "booleanRule": {
                    "condition": {"type": "TEXT_CONTAINS", "values": [{"userEnteredValue": "OK"}]},
                    "format": {
                        "backgroundColor": _rgb(232, 245, 233),
                        "textFormat": {"foregroundColor": _rgb(27, 94, 32), "bold": True},
                    },
                },
            },
        ],
    )

    allowed_sheet_titles = {
        BUDGET_PLAN_SHEET,
        OPERATIONS_REGISTER_SHEET,
        PL_SHEET,
        CASHFLOW_SHEET,
        PLAN_FACT_SHEET,
        UNIT_ECONOMICS_SHEET,
        DASHBOARD_SHEET,
        DATA_QUALITY_SHEET,
    }
    _cleanup_obsolete_sheets(spreadsheet, allowed_sheet_titles)

    return {
        "spreadsheet_id": spreadsheet.id,
        "spreadsheet_url": spreadsheet.url,
        "created": created,
        "months": dashboard_months,
    }


async def setup_management_spreadsheet(force_reset: bool = False) -> dict:
    """Ensures workbook exists and syncs all reports from DB."""
    operations = await get_all_operations_for_export()
    return await asyncio.to_thread(_sync_management_workbook, operations, None, force_reset)


async def sync_management_spreadsheet_from_operations(
    operations: list[dict],
    *,
    force_reset: bool = False,
) -> dict:
    """Syncs workbook from externally supplied normalized operations."""

    return await asyncio.to_thread(_sync_management_workbook, operations, None, force_reset)


async def reset_management_spreadsheet() -> dict:
    """
    Rebuilds workbook from current DB state and force-resets user-entered tables.

    Used for secured full wipe flow.
    """
    return await setup_management_spreadsheet(force_reset=True)


async def append_operation_to_sheet(operation_data: dict, operation_id: int):
    """
    Keeps backward-compatible export hook.

    Sync is full-book because reports are rebuilt from the register.
    """
    if not config.GOOGLE_CREDS_PATH:
        return
    try:
        await setup_management_spreadsheet()
        logger.info("Operation #%s synced to Google Sheets", operation_id)
    except FileNotFoundError:
        logger.warning("Google Sheets sync skipped: credentials file is missing.")
    except Exception as exc:
        logger.error("Google Sheets sync failed: %s", exc, exc_info=True)
