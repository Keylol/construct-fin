"""
Обработчик callback-кнопок.
Подтверждение операций + отчёты с периодами.
"""

import logging
from datetime import datetime, timedelta

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes

import config
from bot.services.database import (
    add_operation,
    find_client_by_name,
    add_client,
)
from bot.services.report_builder import build_report
from bot.handlers.messages import format_operation_card, OPERATION_EMOJI

logger = logging.getLogger(__name__)


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обрабатывает нажатия на inline-кнопки."""
    query = update.callback_query
    await query.answer()
    data = query.data

    # --- Подтверждение операции ---
    if data == "confirm_save":
        await _save_operation(query, context)
    elif data == "confirm_cancel":
        context.user_data.pop("pending_operation", None)
        context.user_data.pop("input_step", None)
        await query.edit_message_text("❌ Операция отменена.")

    # --- Выбор типа операции (из /add) ---
    elif data.startswith("optype_"):
        op_type = data.replace("optype_", "")
        await _start_operation_input(query, context, op_type)

    # --- Выбор категории расхода ---
    elif data.startswith("expcat_"):
        category = data.replace("expcat_", "")
        context.user_data["pending_operation"]["expense_category"] = category
        context.user_data["input_step"] = "amount"
        await query.edit_message_text(
            f"📂 Категория: **{category}**\n\n"
            f"💲 Введите сумму:",
            parse_mode="Markdown",
        )

    # --- Выбор источника оплаты ---
    elif data.startswith("paysrc_"):
        source = data.replace("paysrc_", "")
        context.user_data["pending_operation"]["payment_source"] = source
        context.user_data["input_step"] = "amount"
        src_name = "корпоративная" if source == "корп" else "личная"
        await query.edit_message_text(
            f"💳 Карта: **{src_name}**\n\n"
            f"💲 Введите сумму:",
            parse_mode="Markdown",
        )

    # --- Отчёты ---
    elif data.startswith("report_"):
        report_type = data.replace("report_", "")
        keyboard = [
            [
                InlineKeyboardButton("📅 Неделя", callback_data=f"period_week_{report_type}"),
                InlineKeyboardButton("📅 Месяц", callback_data=f"period_month_{report_type}"),
            ],
            [
                InlineKeyboardButton("📅 Всё время", callback_data=f"period_all_{report_type}"),
            ],
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)

        report_names = {
            "sales": "📈 Продажи",
            "expenses": "📉 Расходы",
            "purchases": "🛒 Закупки",
            "profit": "💰 Прибыль",
            "cashflow": "💸 Денежный поток",
        }
        name = report_names.get(report_type, report_type)
        await query.edit_message_text(
            f"{name}\n\nВыберите период:",
            reply_markup=reply_markup,
        )

    elif data.startswith("period_"):
        await _handle_report_period(query, data)


async def _start_operation_input(query, context, op_type: str):
    """Начинает пошаговый ввод операции после выбора типа."""
    context.user_data["pending_operation"] = {
        "operation_type": op_type,
        "date": datetime.now().strftime("%Y-%m-%d"),
    }

    emoji = OPERATION_EMOJI.get(op_type, "📝")

    if op_type == "расход":
        # Для расхода — сначала выбираем категорию
        keyboard = []
        row = []
        for i, cat in enumerate(config.EXPENSE_CATEGORIES):
            row.append(InlineKeyboardButton(cat, callback_data=f"expcat_{cat}"))
            if len(row) == 2:
                keyboard.append(row)
                row = []
        if row:
            keyboard.append(row)

        reply_markup = InlineKeyboardMarkup(keyboard)
        await query.edit_message_text(
            f"{emoji} **{op_type.capitalize()}**\n\n📂 Выберите категорию:",
            reply_markup=reply_markup,
            parse_mode="Markdown",
        )
    elif op_type in ("закупка", "продажа"):
        # Выбираем источник оплаты
        keyboard = [
            [
                InlineKeyboardButton("🏢 Корпоративная", callback_data="paysrc_корп"),
                InlineKeyboardButton("👤 Личная", callback_data="paysrc_физ"),
            ],
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        await query.edit_message_text(
            f"{emoji} **{op_type.capitalize()}**\n\n💳 С какой карты?",
            reply_markup=reply_markup,
            parse_mode="Markdown",
        )
    else:
        # Предоплата / постоплата — сразу к сумме
        context.user_data["input_step"] = "amount"
        await query.edit_message_text(
            f"{emoji} **{op_type.capitalize()}**\n\n💲 Введите сумму:",
            parse_mode="Markdown",
        )


async def _save_operation(query, context):
    """Сохраняет подтверждённую операцию в БД."""
    parsed = context.user_data.pop("pending_operation", None)
    context.user_data.pop("input_step", None)

    if not parsed:
        await query.edit_message_text("⚠️ Нет операции для сохранения.")
        return

    user = query.from_user
    created_by = f"{user.id}:{user.first_name}"

    # Ищем или создаём клиента
    client_id = None
    if parsed.get("client_name"):
        clients = await find_client_by_name(parsed["client_name"])
        if clients:
            client_id = clients[0]["id"]
        else:
            client_id = await add_client(parsed["client_name"], "не указан")

    op_id = await add_operation(
        date=parsed.get("date", datetime.now().strftime("%Y-%m-%d")),
        operation_type=parsed["operation_type"],
        description=parsed.get("description", ""),
        amount=parsed["amount"],
        created_by=created_by,
        expense_category=parsed.get("expense_category"),
        expense_subcategory=parsed.get("expense_subcategory"),
        expense_block=parsed.get("expense_block"),
        client_id=client_id,
        supplier=parsed.get("supplier"),
        payment_source=parsed.get("payment_source"),
        comment=parsed.get("comment"),
    )

    from bot.services.sheets import append_operation_to_sheet
    await append_operation_to_sheet(parsed, op_id)

    emoji = OPERATION_EMOJI.get(parsed["operation_type"], "📝")
    await query.edit_message_text(
        f"✅ Операция сохранена! (#{op_id})\n\n"
        f"{emoji} {parsed['operation_type'].capitalize()}: "
        f"{parsed.get('description', '')} — "
        f"{parsed['amount']:,.0f} ₽"
    )


async def _handle_report_period(query, data: str):
    """Обрабатывает выбор периода для отчёта."""
    parts = data.split("_", 2)
    period = parts[1]
    report_type = parts[2]

    now = datetime.now()
    if period == "week":
        start_date = (now - timedelta(days=7)).strftime("%Y-%m-%d")
        period_label = "за последнюю неделю"
    elif period == "month":
        start_date = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        period_label = "за последний месяц"
    else:
        start_date = "2000-01-01"
        period_label = "за всё время"

    end_date = now.strftime("%Y-%m-%d")

    try:
        report_text = await build_report(report_type, start_date, end_date)
        await query.edit_message_text(
            f"📊 **Отчёт {period_label}**\n\n{report_text}",
            parse_mode="Markdown",
        )
    except Exception as e:
        logger.error(f"Ошибка отчёта: {e}")
        await query.edit_message_text(f"❌ Ошибка формирования отчёта: {e}")
