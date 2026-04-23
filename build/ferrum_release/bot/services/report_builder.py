"""Report builders for sales, expenses, purchases, profit and cashflow."""

import config
from bot.services.database import get_operations_by_period


def _is_spec_aggregate_operation(operation: dict) -> bool:
    comment = str(operation.get("comment") or "").strip().lower()
    return comment.startswith("spec_aggregate:")


async def build_report(
    report_type: str,
    start_date: str,
    end_date: str,
    *,
    created_by: str | None = None,
) -> str:
    builders = {
        "sales": _report_sales,
        "expenses": _report_expenses,
        "nonop_expenses": _report_nonop_expenses,
        "purchases": _report_purchases,
        "profit": _report_profit,
        "cashflow": _report_cashflow,
    }

    builder = builders.get(report_type)
    if not builder:
        return f"Неизвестный тип отчета: {report_type}"

    return await builder(start_date, end_date, created_by=created_by)


async def _report_sales(start_date: str, end_date: str, *, created_by: str | None = None) -> str:
    ops = await get_operations_by_period(start_date, end_date, "продажа", created_by=created_by)
    if not ops:
        return "Нет продаж за указанный период."

    total = sum(op["amount"] for op in ops)
    lines = [f"Продажи ({start_date} - {end_date})", ""]

    for index, op in enumerate(ops, 1):
        client = op.get("client_name") or "-"
        lines.append(
            f"{index}. {op['date']} | {op['description']} | {op['amount']:,.0f} ₽ | клиент: {client}"
        )

    lines.append("")
    lines.append(f"Итого: {total:,.0f} ₽ ({len(ops)} шт.)")
    return "\n".join(lines)


async def _report_expenses(start_date: str, end_date: str, *, created_by: str | None = None) -> str:
    ops = [
        op
        for op in await get_operations_by_period(start_date, end_date, created_by=created_by)
        if op["operation_type"] in {"расход", "закупка"}
        and not _is_spec_aggregate_operation(op)
    ]
    if not ops:
        return "Нет расходов за указанный период."

    total = sum(op["amount"] for op in ops)
    categories = {}
    for op in ops:
        category = op.get("expense_category") or ("Комплектующие" if op["operation_type"] == "закупка" else "Без категории")
        categories.setdefault(category, []).append(op)

    lines = [f"Расходы ({start_date} - {end_date})", ""]
    sorted_categories = sorted(categories.items(), key=lambda x: -sum(item["amount"] for item in x[1]))

    for category, category_ops in sorted_categories:
        cat_total = sum(op["amount"] for op in category_ops)
        pct = (cat_total / total * 100) if total else 0
        lines.append(f"{category}: {cat_total:,.0f} ₽ ({pct:.0f}%)")
        for op in category_ops:
            lines.append(f"- {op['date']} {op['description']} - {op['amount']:,.0f} ₽")
        lines.append("")

    lines.append(f"Итого расходов: {total:,.0f} ₽")
    return "\n".join(lines)


def _is_non_operating_expense(operation: dict) -> bool:
    if operation.get("operation_type") != "расход":
        return False
    category = str(operation.get("expense_category") or "").strip()
    return category not in config.COMMERCIAL_EXPENSE_CATEGORIES


async def _report_nonop_expenses(start_date: str, end_date: str, *, created_by: str | None = None) -> str:
    all_ops = await get_operations_by_period(start_date, end_date, "расход", created_by=created_by)
    ops = [op for op in all_ops if _is_non_operating_expense(op)]
    if not ops:
        return "Нет внереализационных расходов за указанный период."

    total = sum(op["amount"] for op in ops)
    grouped: dict[tuple[str, str], list[dict]] = {}
    for op in ops:
        category = str(op.get("expense_category") or "Без категории").strip()
        subcategory = str(op.get("expense_subcategory") or "Прочее").strip()
        grouped.setdefault((category, subcategory), []).append(op)

    lines = [f"Внереализационные расходы ({start_date} - {end_date})", ""]
    sorted_groups = sorted(
        grouped.items(),
        key=lambda item: -sum(row["amount"] for row in item[1]),
    )
    for (category, subcategory), rows in sorted_groups:
        subtotal = sum(item["amount"] for item in rows)
        pct = (subtotal / total * 100.0) if total else 0.0
        lines.append(f"{category} / {subcategory}: {subtotal:,.0f} ₽ ({pct:.1f}%)")
    lines.append("")
    lines.append(f"Итого внереализационных расходов: {total:,.0f} ₽")
    return "\n".join(lines)


async def _report_purchases(start_date: str, end_date: str, *, created_by: str | None = None) -> str:
    ops = [
        op
        for op in await get_operations_by_period(start_date, end_date, "закупка", created_by=created_by)
        if not _is_spec_aggregate_operation(op)
    ]
    if not ops:
        return "Нет закупок за указанный период."

    total = sum(op["amount"] for op in ops)
    suppliers = {}
    for op in ops:
        supplier = op.get("supplier") or "Не указан"
        suppliers.setdefault(supplier, []).append(op)

    lines = [f"Закупки ({start_date} - {end_date})", ""]
    sorted_suppliers = sorted(suppliers.items(), key=lambda x: -sum(item["amount"] for item in x[1]))

    for supplier, supplier_ops in sorted_suppliers:
        sup_total = sum(op["amount"] for op in supplier_ops)
        lines.append(f"{supplier}: {sup_total:,.0f} ₽ ({len(supplier_ops)} шт.)")
        for op in supplier_ops:
            lines.append(f"- {op['date']} {op['description']} - {op['amount']:,.0f} ₽")
        lines.append("")

    lines.append(f"Итого закупок: {total:,.0f} ₽")
    return "\n".join(lines)


async def _report_profit(start_date: str, end_date: str, *, created_by: str | None = None) -> str:
    all_ops = await get_operations_by_period(start_date, end_date, created_by=created_by)

    income = sum(
        op["amount"]
        for op in all_ops
        if op["operation_type"] in ("продажа", "предоплата", "постоплата")
    )
    sold_order_ids = {
        int(op["order_id"])
        for op in all_ops
        if op["operation_type"] == "продажа" and op.get("order_id")
    }
    purchases = sum(
        op["amount"]
        for op in all_ops
        if (
            op["operation_type"] == "закупка"
            and not _is_spec_aggregate_operation(op)
            and op.get("order_id")
            and int(op["order_id"]) in sold_order_ids
        )
    )
    commercial_expenses = sum(
        op["amount"]
        for op in all_ops
        if op["operation_type"] == "расход"
        and str(op.get("expense_category") or "").strip() in config.COMMERCIAL_EXPENSE_CATEGORIES
    )
    nonop_expenses = sum(
        op["amount"]
        for op in all_ops
        if op["operation_type"] == "расход"
        and str(op.get("expense_category") or "").strip() not in config.COMMERCIAL_EXPENSE_CATEGORIES
    )
    expenses = commercial_expenses + nonop_expenses
    total_expenses = purchases + expenses
    profit = income - total_expenses

    lines = [
        f"Прибыль ({start_date} - {end_date})",
        "",
        f"Доходы (продажи): {income:,.0f} ₽",
        f"Закупки: {purchases:,.0f} ₽",
        f"Коммерческие расходы: {commercial_expenses:,.0f} ₽",
        f"Внереализационные расходы: {nonop_expenses:,.0f} ₽",
        f"Расходы всего: {expenses:,.0f} ₽",
        "",
        f"Прибыль: {profit:,.0f} ₽",
    ]

    if income > 0:
        margin = (profit / income) * 100
        lines.append(f"Маржа: {margin:.1f}%")

    return "\n".join(lines)


async def _report_cashflow(start_date: str, end_date: str, *, created_by: str | None = None) -> str:
    all_ops = await get_operations_by_period(start_date, end_date, created_by=created_by)
    if not all_ops:
        return "Нет операций за указанный период."

    sources: dict[str, dict[str, float]] = {}

    for op in all_ops:
        source = op.get("payment_account") or op.get("payment_source") or "Не указан"
        if source not in sources:
            sources[source] = {"in": 0.0, "out": 0.0}

        if op["operation_type"] in ("продажа", "предоплата", "постоплата"):
            sources[source]["in"] += op["amount"]
        elif op["operation_type"] == "закупка":
            if _is_spec_aggregate_operation(op):
                continue
            sources[source]["out"] += op["amount"]
        elif op["operation_type"] == "расход":
            sources[source]["out"] += op["amount"]

    lines = [f"Денежный поток ({start_date} - {end_date})", ""]
    total_in = 0.0
    total_out = 0.0

    for source, values in sorted(sources.items(), key=lambda item: item[0]):
        if values["in"] == 0 and values["out"] == 0:
            continue

        net = values["in"] - values["out"]
        lines.append(f"{source}:")
        lines.append(f"  Приход: {values['in']:,.0f} ₽")
        lines.append(f"  Расход: {values['out']:,.0f} ₽")
        lines.append(f"  Итог: {net:,.0f} ₽")
        lines.append("")

        total_in += values["in"]
        total_out += values["out"]

    lines.append(f"Общий приход: {total_in:,.0f} ₽")
    lines.append(f"Общий расход: {total_out:,.0f} ₽")
    lines.append(f"Баланс: {total_in - total_out:,.0f} ₽")

    return "\n".join(lines)
