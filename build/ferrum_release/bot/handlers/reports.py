"""Text-only report command handler."""

from __future__ import annotations

from datetime import datetime, timedelta

from telegram import Update
from telegram.ext import ContextTypes

from bot.services.report_builder import build_report

REPORT_TYPE_ALIASES = {
    "sales": "sales",
    "sale": "sales",
    "продажа": "sales",
    "продажи": "sales",
    "expenses": "expenses",
    "expense": "expenses",
    "расход": "expenses",
    "расходы": "expenses",
    "внереализационные": "nonop_expenses",
    "внереализационный": "nonop_expenses",
    "внереал": "nonop_expenses",
    "nonop": "nonop_expenses",
    "nonop_expenses": "nonop_expenses",
    "purchases": "purchases",
    "purchase": "purchases",
    "закупка": "purchases",
    "закупки": "purchases",
    "profit": "profit",
    "прибыль": "profit",
    "cashflow": "cashflow",
    "денежный": "cashflow",
    "поток": "cashflow",
}

PERIOD_ALIASES = {
    "week": "week",
    "неделя": "week",
    "month": "month",
    "месяц": "month",
    "all": "all",
    "всё": "all",
    "все": "all",
    "today": "today",
    "сегодня": "today",
}

REPORT_NAMES = {
    "sales": "Продажи",
    "expenses": "Расходы",
    "nonop_expenses": "Внереализационные расходы",
    "purchases": "Закупки",
    "profit": "Прибыль",
    "cashflow": "Денежный поток",
}


def _parse_date(value: str) -> str | None:
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        return None


def _resolve_period(period: str | None) -> tuple[str, str, str]:
    now = datetime.now()
    period = period or "month"

    if period == "today":
        start_date = now.strftime("%Y-%m-%d")
        label = "за сегодня"
    elif period == "week":
        start_date = (now - timedelta(days=7)).strftime("%Y-%m-%d")
        label = "за 7 дней"
    elif period == "all":
        start_date = "2000-01-01"
        label = "за все время"
    else:
        start_date = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        label = "за 30 дней"

    end_date = now.strftime("%Y-%m-%d")
    return start_date, end_date, label


def _help_text() -> str:
    return (
        "Формат команды:\n"
        "/report <тип> <период>\n\n"
        "Типы: sales, expenses, nonop_expenses, purchases, profit, cashflow\n"
        "Периоды: today, week, month, all\n\n"
        "Примеры:\n"
        "/report profit month\n"
        "/report sales week\n"
        "/report nonop_expenses month\n"
        "/report expenses 2026-03-01 2026-03-28"
    )


async def handle_report_command(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    created_by: str | None = None,
):
    """Builds report from textual args, without inline buttons."""
    args = [arg.strip().lower() for arg in (context.args or []) if arg.strip()]

    if not args:
        report_type = "profit"
        start_date, end_date, period_label = _resolve_period("month")
    else:
        report_type = REPORT_TYPE_ALIASES.get(args[0])
        if not report_type:
            await update.message.reply_text(f"Неизвестный тип отчета: {args[0]}\n\n{_help_text()}")
            return

        if len(args) >= 3:
            start_date = _parse_date(args[1])
            end_date = _parse_date(args[2])
            if start_date and end_date:
                period_label = f"за период {start_date}..{end_date}"
            else:
                await update.message.reply_text(f"Неверный формат дат.\n\n{_help_text()}")
                return
        else:
            period = PERIOD_ALIASES.get(args[1], "month") if len(args) > 1 else "month"
            start_date, end_date, period_label = _resolve_period(period)

    if created_by:
        report_text = await build_report(report_type, start_date, end_date, created_by=created_by)
    else:
        report_text = await build_report(report_type, start_date, end_date)
    report_name = REPORT_NAMES.get(report_type, report_type)
    await update.message.reply_text(f"{report_name} {period_label}\n\n{report_text}")
