"""Text message handler with AI-driven soft confirmation flow."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime

from telegram import Update
from telegram.ext import ContextTypes

import config
from bot.services import ai_parser
from bot.services.database import (
    add_operation,
    add_audit_log,
    add_recognition_log,
    add_spec_document,
    add_spec_items,
    count_unpriced_spec_items,
    count_order_receipts,
    close_order,
    create_order,
    delete_operation,
    delete_order_if_empty,
    get_next_unpriced_spec_item,
    get_last_operation,
    get_latest_order_for_phone,
    get_operation_by_id,
    get_or_create_client_by_phone,
    get_order_by_id,
    get_order_totals,
    get_primary_spec_document_for_order,
    get_spec_document_by_id,
    get_latest_spec_document_for_order,
    list_spec_items,
    wipe_all_business_data,
    update_spec_item_price,
    normalize_phone,
)
from bot.services.quality_journal import append_quality_journal_entry
from bot.services.sheets import append_operation_to_sheet, reset_management_spreadsheet, setup_management_spreadsheet
from bot.services.spec_parser import looks_like_spec_text, parse_spec_text

logger = logging.getLogger(__name__)

PENDING_OPERATION_KEY = "pending_operation"
PENDING_SOURCE_TEXT_KEY = "pending_source_text"
PENDING_MISSING_KEY = "pending_missing"
PENDING_WAITING_ORDER_PHONE_KEY = "pending_waiting_order_phone"
ACTIVE_ORDER_ID_KEY = "active_order_id"
ACTIVE_CLIENT_ID_KEY = "active_client_id"
ACTIVE_ORDER_PHONE_KEY = "active_order_phone"
PENDING_SPEC_PRICING_KEY = "pending_spec_pricing"
PENDING_SPEC_SALE_KEY = "pending_spec_sale"
PENDING_DELETE_KEY = "pending_delete"
PENDING_ORDER_ACTION_KEY = "pending_order_action"
PENDING_WIPE_KEY = "pending_wipe"

OPERATION_EMOJI = {
    "продажа": "💰",
    "закупка": "🛒",
    "предоплата": "💵",
    "постоплата": "💵",
    "расход": "💸",
}

CANCEL_WORDS = {"отмена", "cancel", "стоп"}
CONFIRM_WORDS = {"ок", "ok", "да", "сохранить", "подтверждаю"}
CORRECTION_PREFIX = "исправь"
DELETE_PREFIX = "удали"
ORDER_OPEN_PREFIXES = ("заказ", "открой заказ", "создай заказ", "новый заказ")
ORDER_CLOSE_PREFIXES = ("закрой заказ", "закрыть заказ")
ORDER_CARD_PREFIXES = ("карточка", "покажи карточку", "покажи заказ", "мой заказ")
ORDER_DELETE_PREFIXES = (
    "удали карточку",
    "удалить карточку",
    "удали клиента",
    "удалить клиента",
    "удали заказ",
    "удалить заказ",
)
MIN_PARSE_CONFIDENCE = 0.72
MIN_INTENT_CONFIDENCE = 0.72
SPEC_LOSS_CONFIRM_PHRASE = "подтверждаю убыток"


def _context_role(context: ContextTypes.DEFAULT_TYPE) -> str:
    role = str(context.user_data.get("user_role") or "").strip().lower()
    if role in {"owner", "operator"}:
        return role
    return "owner"


async def _safe_audit_log(
    *,
    event_type: str,
    user_id: int,
    first_name: str,
    role: str,
    command_name: str | None = None,
    details: str | None = None,
):
    try:
        await add_audit_log(
            event_type,
            actor_user_id=int(user_id),
            actor_name=first_name,
            actor_role=role,
            command_name=command_name,
            details=details,
        )
    except Exception:
        logger.warning("Could not append audit log (%s)", event_type, exc_info=True)


def _is_wipe_trigger_text(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    trigger = config.DATA_WIPE_TRIGGER_CODE.strip().lower()
    if lowered == trigger:
        return True
    if lowered == f"/{trigger}":
        return True
    if lowered.startswith(f"/{trigger}@"):
        return True
    return False


def _wipe_pin_prompt() -> str:
    return (
        "Запрошена зачистка данных.\n"
        "Введите PIN-код для подтверждения.\n"
        "Для отмены напишите `отмена`."
    )


def _normalize_parsed_data(parsed_data: dict) -> dict:
    """Applies defaults and strict shape to parsed operation."""
    normalized = dict(parsed_data or {})
    normalized["_invalid_date"] = bool(normalized.get("_invalid_date"))
    if normalized.get("date"):
        normalized["date"] = str(normalized.get("date")).strip()
    elif not normalized["_invalid_date"]:
        normalized["date"] = datetime.now().date().isoformat()
    else:
        normalized["date"] = ""
    normalized["description"] = str(normalized.get("description") or "").strip()
    normalized["operation_type"] = str(normalized.get("operation_type") or "").strip().lower()
    normalized["payment_source"] = str(normalized.get("payment_source") or "физ").strip().lower()
    normalized["payment_account"] = str(normalized.get("payment_account") or "").strip()
    normalized["payment_method"] = str(normalized.get("payment_method") or "").strip().lower()
    normalized["business_direction"] = str(
        normalized.get("business_direction") or config.DEFAULT_BUSINESS_DIRECTION
    ).strip()
    normalized["income_channel"] = str(normalized.get("income_channel") or "").strip()
    normalized["sale_type"] = str(normalized.get("sale_type") or "Сборка").strip().title()
    normalized["expense_subcategory"] = str(normalized.get("expense_subcategory") or "").strip() or None
    normalized["expense_block"] = str(normalized.get("expense_block") or "").strip() or None
    normalized["client_phone"] = normalize_phone(normalized.get("client_phone"))
    normalized["_clarify_question"] = str(normalized.get("_clarify_question") or "").strip() or None
    try:
        normalized["_confidence"] = float(normalized.get("_confidence", 0.75))
    except (TypeError, ValueError):
        normalized["_confidence"] = 0.75

    amount = normalized.get("amount", 0)
    if isinstance(amount, str):
        amount = amount.replace(" ", "").replace(",", ".")
    try:
        normalized["amount"] = float(amount)
    except (TypeError, ValueError):
        normalized["amount"] = 0.0

    if normalized["operation_type"] not in config.OPERATION_TYPES:
        normalized["operation_type"] = "расход"
    if normalized["payment_source"] not in config.PAYMENT_SOURCES:
        normalized["payment_source"] = "физ"

    normalized_account = config.normalize_payment_account(normalized["payment_account"])
    if normalized_account:
        normalized["payment_account"] = normalized_account
    else:
        default_account = config.default_payment_account_for_operation(normalized["operation_type"])
        normalized["payment_account"] = default_account or ""

    if normalized["payment_account"]:
        normalized["payment_source"] = config.payment_source_for_account(normalized["payment_account"])
        if normalized["payment_method"] not in config.PAYMENT_METHODS:
            normalized["payment_method"] = config.payment_method_for_account(
                normalized["payment_account"],
                normalized.get("description", ""),
            )
        elif normalized["payment_account"] == "Наличные":
            normalized["payment_method"] = "наличные"
    elif normalized["payment_method"] not in config.PAYMENT_METHODS:
        normalized["payment_method"] = "карта"

    if normalized["sale_type"] not in config.SALE_TYPES:
        normalized["sale_type"] = "Сборка"
    if normalized["income_channel"] and normalized["income_channel"] not in config.INCOME_CHANNELS:
        normalized["income_channel"] = "Онлайн"
    if not normalized["income_channel"] and normalized["operation_type"] in {"продажа", "предоплата", "постоплата"}:
        normalized["income_channel"] = "Онлайн"
    if not normalized["business_direction"]:
        normalized["business_direction"] = config.DEFAULT_BUSINESS_DIRECTION

    if normalized["operation_type"] == "закупка" and not normalized.get("expense_category"):
        normalized["expense_category"] = "Комплектующие"

    if ai_parser._is_office_opex_text(normalized.get("description", "")):  # noqa: SLF001
        normalized["operation_type"] = "расход"
        if not normalized.get("expense_category"):
            normalized["expense_category"] = "Офис"
        normalized["_confidence"] = max(float(normalized.get("_confidence", 0.75)), 0.9)

    normalized_category, normalized_subcategory = config.normalize_expense_taxonomy(
        category=normalized.get("expense_category"),
        subcategory=normalized.get("expense_subcategory"),
        description=normalized.get("description"),
    )
    normalized["expense_category"] = normalized_category
    normalized["expense_subcategory"] = normalized_subcategory
    normalized["expense_block"] = config.expense_block(normalized_category)

    if normalized.get("operation_type") in {"продажа", "предоплата", "постоплата"}:
        normalized["expense_category"] = None
        normalized["expense_subcategory"] = None
        normalized["expense_block"] = None

    normalized["_confidence"] = max(0.0, min(float(normalized.get("_confidence", 0.75)), 1.0))

    return normalized


def format_operation_card(data: dict) -> str:
    """Formats operation info as user-facing text card."""
    emoji = OPERATION_EMOJI.get(data.get("operation_type", ""), "📝")
    op_type = str(data.get("operation_type", "операция")).capitalize()

    lines = [
        f"{emoji} {op_type}: {data.get('amount', 0):,.0f} ₽",
        f"Описание: {data.get('description', '-')}",
        f"Дата: {data.get('date', '-')}",
    ]

    if data.get("order_phone"):
        lines.append(f"Заказ: {data['order_phone']}")
    if data.get("sale_type") and data.get("operation_type") in {"продажа", "предоплата", "постоплата"}:
        lines.append(f"Тип: {data['sale_type']}")
    if data.get("supplier"):
        lines.append(f"Поставщик: {data['supplier']}")
    if data.get("expense_category"):
        lines.append(f"Категория: {data['expense_category']}")
    if data.get("expense_subcategory"):
        lines.append(f"Подкатегория: {data['expense_subcategory']}")
    if data.get("payment_account"):
        lines.append(f"Счет: {data['payment_account']}")
    if data.get("income_channel"):
        lines.append(f"Канал: {data['income_channel']}")
    return "\n".join(lines)


def _missing_fields(payload: dict) -> list[str]:
    missing = []
    if payload.get("amount", 0) <= 0:
        missing.append("amount")
    if payload.get("operation_type") not in config.OPERATION_TYPES:
        missing.append("operation_type")
    if not str(payload.get("description", "")).strip():
        missing.append("description")
    if payload.get("_invalid_date"):
        missing.append("date")
    if float(payload.get("_confidence", 0.75)) < MIN_PARSE_CONFIDENCE:
        missing.append("confidence")
    operation_type = str(payload.get("operation_type") or "").strip().lower()
    if operation_type == "расход" and not payload.get("expense_category"):
        missing.append("expense_category")
    if operation_type == "расход" and not payload.get("expense_subcategory"):
        missing.append("expense_subcategory")
    if operation_type == "расход" and not payload.get("payment_account"):
        missing.append("payment_account")
    return missing


def _question_for(field: str, payload: dict | None = None) -> str:
    if field == "amount":
        return "Напишите сумму числом. Пример: 55000"
    if field == "operation_type":
        return "Это продажа, закупка, предоплата, постоплата или расход?"
    if field == "description":
        return "Коротко напишите описание операции."
    if field == "date":
        return "Не распознал дату. Напишите дату в формате ДД.ММ.ГГГГ или YYYY-MM-DD."
    if field == "confidence":
        if payload and payload.get("_clarify_question"):
            return str(payload["_clarify_question"])
        return "Уточните, пожалуйста: это операция по заказу клиента или общий расход бизнеса?"
    if field == "expense_category":
        return "Укажите категорию расхода (например: Офис, Аренда, Зарплатный фонд, Внешние исполнители, Развитие бизнеса)."
    if field == "expense_subcategory":
        category = str((payload or {}).get("expense_category") or "категория")
        return f"Укажите подкатегорию для `{category}`."
    if field == "payment_account":
        return "Укажите счет оплаты (например: ИП Каменский АБ, Каменский ВБ, Антропов ВБ, Каменский ОБ, Наличные)."
    return "Уточните, пожалуйста."


def _to_json(payload: dict | None) -> str | None:
    if payload is None:
        return None
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


async def _log_quality_event(
    *,
    source_text: str,
    created_by: str,
    status: str,
    parser_mode: str = "unknown",
    parsed_payload: str | None = None,
    final_payload: str | None = None,
    correction_text: str | None = None,
):
    await add_recognition_log(
        source_text=source_text,
        created_by=created_by,
        status=status,
        parser_mode=parser_mode,
        parsed_payload=parsed_payload,
        final_payload=final_payload,
        correction_text=correction_text,
    )
    try:
        await append_quality_journal_entry(
            source_text=source_text,
            created_by=created_by,
            status=status,
            parser_mode=parser_mode,
            parsed_payload=parsed_payload,
            final_payload=final_payload,
            correction_text=correction_text,
        )
    except Exception:
        logger.warning("Could not append quality journal entry", exc_info=True)


def _operation_needs_order(
    pending: dict,
    *,
    source_text: str,
    has_active_order: bool,
) -> bool:
    operation_type = str(pending.get("operation_type") or "").strip().lower()
    if operation_type in {"продажа", "предоплата", "постоплата"}:
        return True
    if operation_type != "закупка":
        return False

    if ai_parser._is_office_opex_text(source_text):  # noqa: SLF001
        return False

    if pending.get("client_phone") or pending.get("client_name"):
        return True
    if ai_parser._is_order_related_text(source_text):  # noqa: SLF001
        return True
    if has_active_order:
        return True

    return False


def _is_confirmation_text(text: str) -> bool:
    lowered = text.strip().lower()
    if lowered in CONFIRM_WORDS:
        return True
    patterns = (
        "ок,",
        "ок ",
        "все верно",
        "всё верно",
        "верно",
        "сохраняй",
        "подтверждаю",
        "давай сохраним",
    )
    return any(pattern in lowered for pattern in patterns)


def _is_cancel_text(text: str) -> bool:
    lowered = text.strip().lower()
    if lowered in CANCEL_WORDS:
        return True
    patterns = ("не сохраняй", "отмени", "отменить", "отмена", "стоп")
    return any(pattern in lowered for pattern in patterns)


def _looks_like_operation_text(text: str) -> bool:
    lowered = text.lower()
    op_markers = (
        "прод", "куп", "закуп", "расход", "предоплат", "постоплат",
        "доплат", "оплата", "поступил", "списал", "налог", "аренда",
    )
    if any(marker in lowered for marker in op_markers):
        return True
    phone = _extract_phone_from_text(text)
    return ai_parser._extract_amount_from_text(text, phone) > 0  # noqa: SLF001


def _extract_order_open_payload(text: str) -> tuple[str, str | None] | None:
    lowered = text.strip().lower()
    if not any(lowered.startswith(prefix) for prefix in ORDER_OPEN_PREFIXES):
        return None
    if _looks_like_operation_text(text):
        return None

    phone = _extract_phone_from_text(text)
    if not phone:
        return None

    cleaned = re.sub(r"(?:\+7|8)?[\d\-\s()]{10,20}", " ", text)
    for prefix in ORDER_OPEN_PREFIXES:
        cleaned = re.sub(rf"^\s*{re.escape(prefix)}\s*", "", cleaned, flags=re.IGNORECASE)
    full_name = re.sub(r"\s+", " ", cleaned).strip(" ,.-")
    return phone, (full_name if full_name else None)


def _is_close_order_intent(text: str) -> bool:
    lowered = text.strip().lower()
    return any(lowered.startswith(prefix) for prefix in ORDER_CLOSE_PREFIXES)


def _is_card_intent(text: str) -> bool:
    lowered = text.strip().lower()
    return any(lowered.startswith(prefix) for prefix in ORDER_CARD_PREFIXES)


def _is_delete_card_intent(text: str) -> bool:
    lowered = text.strip().lower()
    return any(prefix in lowered for prefix in ORDER_DELETE_PREFIXES)


async def _handle_open_order_intent(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    created_by: str,
    telegram_username: str | None,
    phone: str,
    full_name: str | None,
):
    client_id, created = await get_or_create_client_by_phone(
        phone=phone,
        full_name=full_name,
        telegram_username=telegram_username,
        created_by=created_by,
    )
    order_id = await create_order(
        client_id=client_id,
        order_phone=phone,
        opened_by=created_by,
        sale_type="Сборка",
    )

    context.user_data[ACTIVE_ORDER_ID_KEY] = order_id
    context.user_data[ACTIVE_CLIENT_ID_KEY] = client_id
    context.user_data[ACTIVE_ORDER_PHONE_KEY] = phone

    created_text = "Создана новая карточка клиента." if created else "Открыта существующая карточка клиента."
    await update.message.reply_text(
        f"{created_text}\n"
        f"Активный заказ: #{order_id}\n"
        f"Телефон заказа: {phone}\n\n"
        "Теперь просто пишите операции текстом."
    )


async def _handle_close_order_intent(update: Update, context: ContextTypes.DEFAULT_TYPE, created_by: str):
    order_id = context.user_data.get(ACTIVE_ORDER_ID_KEY)
    if not order_id:
        await update.message.reply_text("Сейчас нет активного заказа.")
        return
    closed = await close_order(int(order_id), created_by)
    context.user_data.pop(ACTIVE_ORDER_ID_KEY, None)
    context.user_data.pop(ACTIVE_CLIENT_ID_KEY, None)
    context.user_data.pop(ACTIVE_ORDER_PHONE_KEY, None)
    if closed:
        await update.message.reply_text(
            f"Заказ #{order_id} помечен закрытым в боте.\n\n"
            "Для финансового закрытия (продажа / оплата / себестоимость) — "
            "используйте Мини-Приложение."
        )
    else:
        await update.message.reply_text("Заказ уже был закрыт или не найден.")


async def _handle_card_intent(update: Update, context: ContextTypes.DEFAULT_TYPE):
    order_id = context.user_data.get(ACTIVE_ORDER_ID_KEY)
    if not order_id:
        await update.message.reply_text("Нет активного заказа. Откройте: /order +79991234567")
        return
    order = await get_order_by_id(int(order_id))
    if not order:
        await update.message.reply_text("Не нашел активный заказ. Откройте заново через /order.")
        return
    totals = await get_order_totals(int(order_id))
    profit = totals["income_total"] - totals["cogs_total"] - totals["opex_total"]
    await update.message.reply_text(
        f"Карточка заказа #{order['id']}\n"
        f"Телефон: {order['order_phone']}\n"
        f"Клиент: {order.get('client_name') or '-'}\n"
        f"Статус: {order['status']}\n"
        f"Тип продажи: {order.get('sale_type') or 'Сборка'}\n\n"
        f"Доход: {totals['income_total']:,.0f} ₽\n"
        f"Себестоимость: {totals['cogs_total']:,.0f} ₽\n"
        f"OPEX: {totals['opex_total']:,.0f} ₽\n"
        f"Итог: {profit:,.0f} ₽\n"
        f"Операций: {totals['operations_count']}"
    )


async def _handle_delete_card_intent(update: Update, context: ContextTypes.DEFAULT_TYPE):
    order_id = context.user_data.get(ACTIVE_ORDER_ID_KEY)
    if not order_id:
        await update.message.reply_text("Нет активной карточки для удаления.")
        return

    result = await delete_order_if_empty(int(order_id))
    if not result.get("deleted"):
        reason = result.get("reason")
        if reason == "not_empty":
            await update.message.reply_text(
                "Не могу удалить карточку: в ней уже есть данные.\n"
                f"Операций: {result.get('operations_count', 0)}, документов: {result.get('documents_count', 0)}.\n"
                "Чтобы завершить работу, используйте: `закрой заказ`."
            )
        else:
            await update.message.reply_text("Карточка не найдена или уже удалена.")
        return

    context.user_data.pop(ACTIVE_ORDER_ID_KEY, None)
    context.user_data.pop(ACTIVE_CLIENT_ID_KEY, None)
    context.user_data.pop(ACTIVE_ORDER_PHONE_KEY, None)

    if result.get("deleted_client"):
        await update.message.reply_text("Удалил карточку заказа и пустую карточку клиента.")
    else:
        await update.message.reply_text("Удалил пустую карточку активного заказа.")


async def _handle_intent_fallback(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    created_by: str,
    telegram_username: str | None,
    text: str,
    *,
    role: str = "owner",
) -> bool:
    """Runs when operation parsing failed; tries adaptive AI intent routing."""
    intent_payload = await ai_parser.parse_user_intent(text)
    intent = str(intent_payload.get("intent") or "other")

    if intent == "open_order":
        phone = intent_payload.get("phone") or _extract_phone_from_text(text)
        if phone:
            await _handle_open_order_intent(
                update=update,
                context=context,
                created_by=created_by,
                telegram_username=telegram_username,
                phone=phone,
                full_name=intent_payload.get("full_name"),
            )
            return True
        return False

    if intent == "close_order":
        await _handle_close_order_intent(update, context, created_by=created_by)
        return True

    if intent == "show_card":
        await _handle_card_intent(update, context)
        return True

    if intent == "delete_card":
        await _handle_delete_card_intent(update, context)
        return True

    if intent == "delete_operation":
        operation_id = intent_payload.get("operation_id")
        delete_last = bool(intent_payload.get("delete_last"))
        target_id = operation_id
        if delete_last or target_id is None:
            last_op = await get_last_operation(created_by=None if role == "owner" else created_by)
            if not last_op:
                await update.message.reply_text("Не нашел последнюю вашу операцию для удаления.")
                return True
            target_id = int(last_op["id"])

        operation = await get_operation_by_id(int(target_id))
        if not operation:
            await update.message.reply_text(f"Операция #{target_id} не найдена.")
            return True
        if role != "owner" and str(operation.get("created_by") or "") != created_by:
            await update.message.reply_text("Можно удалять только собственные операции.")
            return True

        if await delete_operation(int(target_id)):
            try:
                await setup_management_spreadsheet()
            except Exception:
                logger.warning("Could not resync sheets after delete operation #%s", target_id, exc_info=True)
            await update.message.reply_text(
                f"Удалил операцию #{target_id}: {operation['description']} на {operation['amount']:,.0f} ₽"
            )
        else:
            await update.message.reply_text(f"Не удалось удалить операцию #{target_id}.")
        return True

    if intent == "cancel_pending":
        await update.message.reply_text("Сейчас нет активной операции для отмены.")
        return True

    if intent == "operation_input":
        await update.message.reply_text(
            "Похоже, это финансовая операция, но не хватило данных.\n"
            "Напишите одним сообщением: что произошло, сумму и тип операции."
        )
        return True

    return False


async def _handle_intent_fallback_v2(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    created_by: str,
    telegram_username: str | None,
    text: str,
    *,
    intent_payload: dict | None = None,
    role: str = "owner",
) -> bool:
    """AI-first intent routing used when operation parsing is empty."""
    intent_payload = intent_payload or await ai_parser.parse_user_intent(text)
    intent = str(intent_payload.get("intent") or "other")
    try:
        confidence = float(intent_payload.get("confidence") or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0

    if confidence < MIN_INTENT_CONFIDENCE:
        return False

    if intent == "open_order":
        phone = intent_payload.get("phone") or _extract_phone_from_text(text)
        if not phone:
            return False
        await _handle_open_order_intent(
            update=update,
            context=context,
            created_by=created_by,
            telegram_username=telegram_username,
            phone=phone,
            full_name=intent_payload.get("full_name"),
        )
        return True

    if intent == "close_order":
        await _handle_close_order_intent(update, context, created_by=created_by)
        return True

    if intent == "show_card":
        await _handle_card_intent(update, context)
        return True

    if intent == "delete_card":
        await _handle_delete_card_intent(update, context)
        return True

    if intent == "delete_operation":
        operation_id = intent_payload.get("operation_id")
        delete_last = bool(intent_payload.get("delete_last"))
        target_id = operation_id
        if delete_last or target_id is None:
            last_op = await get_last_operation(created_by=None if role == "owner" else created_by)
            if not last_op:
                await update.message.reply_text("Не нашел последнюю вашу операцию для удаления.")
                return True
            target_id = int(last_op["id"])
        await queue_delete_confirmation(
            update,
            context,
            target_id=int(target_id),
            requested_by=update.effective_user.id,
            role=role,
            created_by=created_by,
        )
        return True

    if intent == "cancel_pending":
        await update.message.reply_text("Сейчас нет активной операции для отмены.")
        return True

    if intent == "operation_input":
        await update.message.reply_text(
            "Похоже, это финансовая операция, но не хватило данных.\n"
            "Напишите одним сообщением: что произошло, сумму и тип операции."
        )
        return True

    return False


def _extract_phone_from_text(text: str) -> str:
    for match in re.findall(r"(?:\+7|8)?[\d\-\s()]{10,20}", text):
        digits = re.sub(r"\D+", "", match)
        if len(digits) in {10, 11}:
            return normalize_phone(match)
    return ""


def _extract_delete_operation_id(text: str) -> int | None:
    lowered = text.lower()
    if not lowered.startswith(DELETE_PREFIX):
        return None
    if "последн" in lowered:
        return -1
    match = re.search(r"\b(\d{1,10})\b", lowered)
    if not match:
        return None
    return int(match.group(1))


def _extract_single_amount(text: str) -> float | None:
    match = re.search(r"(\d[\d\s.,]{0,20})", str(text or ""))
    if not match:
        return None
    raw = match.group(1).replace(" ", "").replace(",", ".")
    try:
        value = float(raw)
    except ValueError:
        return None
    if value <= 0:
        return None
    return value


def _spec_account_prompt() -> str:
    lines = ["Укажите счет оплаты закупок для этой спецификации:"]
    for index, account in enumerate(config.DEFAULT_PAYMENT_ACCOUNTS, start=1):
        lines.append(f"{index}. {account}")
    lines.append("")
    lines.append("Можно написать номер (например `1`) или название счета.")
    return "\n".join(lines)


def _spec_item_account_prompt(item: dict) -> str:
    lines = [
        "Укажите счет оплаты для позиции:",
        f"{int(item.get('item_index') or 0)}. {item.get('component_name')}: {item.get('component_value')}",
        "",
    ]
    for index, account in enumerate(config.DEFAULT_PAYMENT_ACCOUNTS, start=1):
        lines.append(f"{index}. {account}")
    lines.append("")
    lines.append("Можно написать номер или название счета.")
    return "\n".join(lines)


def _spec_item_price_prompt(item: dict, account: str) -> str:
    return (
        f"Счет: {account}\n"
        "Введите закупочную стоимость для позиции:\n"
        f"{int(item.get('item_index') or 0)}. {item.get('component_name')}: {item.get('component_value')}\n"
        "Формат: просто число, например `18500`."
    )


def _resolve_spec_purchase_account(text: str) -> str | None:
    lowered = str(text or "").strip().lower()
    if not lowered:
        return None

    number_match = re.search(r"\b([1-9])\b", lowered)
    if number_match:
        index = int(number_match.group(1)) - 1
        if 0 <= index < len(config.DEFAULT_PAYMENT_ACCOUNTS):
            return config.DEFAULT_PAYMENT_ACCOUNTS[index]

    for account in config.DEFAULT_PAYMENT_ACCOUNTS:
        if lowered == account.lower():
            return account

    return config.normalize_payment_account(lowered)


def _spec_category_for_component(component_name: str) -> str:
    lowered = str(component_name or "").strip().lower()
    mapping = (
        (("процессор", "cpu"), "CPU"),
        (("видеокарт", "gpu"), "GPU"),
        (("оператив", "ram"), "RAM"),
        (("накопител", "ssd", "hdd"), "SSD/HDD"),
        (("материн", "motherboard"), "Материнская плата"),
        (("охлажд", "кулер"), "Охлаждение"),
        (("блок пит", "psu"), "Блок питания"),
        (("корпус",), "Корпус"),
        (("монитор", "клав", "мыш", "перифер"), "Периферия"),
    )
    for markers, category in mapping:
        if any(marker in lowered for marker in markers):
            return category
    return "Другое комплектующие"


def _spec_payment_meta(account: str) -> tuple[str, str]:
    return (
        config.payment_source_for_account(account),
        config.payment_method_for_account(account),
    )


def _spec_financials(sale_amount: float, cogs_amount: float) -> dict[str, float]:
    margin = sale_amount - cogs_amount
    margin_pct = (margin / sale_amount * 100.0) if sale_amount > 0 else 0.0
    return {
        "sale": sale_amount,
        "cogs": cogs_amount,
        "margin": margin,
        "margin_pct": margin_pct,
    }


def _spec_financial_summary_text(financials: dict[str, float]) -> str:
    return (
        "Финальный расчет по спецификации:\n"
        f"Продажа: {financials['sale']:,.0f} ₽\n"
        f"Себестоимость: {financials['cogs']:,.0f} ₽\n"
        f"Маржа: {financials['margin']:,.0f} ₽\n"
        f"Маржа %: {financials['margin_pct']:.1f}%"
    )


def _spec_receipts_reminder_text() -> str:
    return (
        "Важно: загрузите в заказ все чеки по закупке комплектующих "
        "(PDF/DOC/DOCX), чтобы документы были привязаны к карточке."
    )


async def _sale_block_reason(payload: dict) -> str | None:
    operation_type = str(payload.get("operation_type") or "").strip().lower()
    if operation_type not in {"продажа", "предоплата", "постоплата"}:
        return None

    order_id = payload.get("order_id")
    if not order_id:
        return "Для продажи нужен заказ. Укажите телефон заказа (пример: +79991234567)."

    primary_spec = await get_primary_spec_document_for_order(int(order_id))
    if not primary_spec or str(primary_spec.get("parse_status") or "").lower() != "parsed":
        return (
            "Продажу по заказу нельзя сохранить без технической спецификации.\n"
            "Сначала пришлите спецификацию (DOCX/PDF или текстом)."
        )

    spec_document_id = int(primary_spec["id"])
    spec_items = await list_spec_items(spec_document_id)
    if not spec_items:
        return (
            "Продажу по заказу пока нельзя сохранить: в спецификации нет позиций.\n"
            "Пришлите корректную спецификацию еще раз."
        )

    unpriced = await count_unpriced_spec_items(spec_document_id)
    if unpriced > 0:
        return (
            f"Продажу по заказу пока нельзя сохранить: не заполнены закупочные цены по {unpriced} позициям.\n"
            "Сначала завершите ввод себестоимости комплектующих."
        )
    return None


async def _start_spec_session(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    order: dict,
    spec_document_id: int,
    customer_total: float | None,
    source_name: str,
):
    context.user_data[PENDING_SPEC_PRICING_KEY] = {
        "spec_document_id": int(spec_document_id),
        "order_id": int(order["id"]),
        "client_id": int(order["client_id"]),
        "current_item_id": None,
        "current_item_account": None,
        "awaiting_finalize": False,
        "awaiting_loss_confirm": False,
        "awaiting_receipt": False,
    }

    context.user_data[PENDING_SPEC_SALE_KEY] = {
        "spec_document_id": int(spec_document_id),
        "order_id": int(order["id"]),
        "client_id": int(order["client_id"]),
        "amount": float(customer_total) if customer_total else None,
        "description": f"Продажа по спецификации {source_name}",
        "sale_type": str(order.get("sale_type") or "Сборка"),
        "awaiting_amount": not bool(customer_total),
        "allow_incomplete_confirmed": False,
    }

    if customer_total:
        await update.message.reply_text(
            f"Нашел итоговую сумму для клиента: {float(customer_total):,.0f} ₽.\n"
            "Теперь укажите счета и цены всех комплектующих. Продажа сохранится после подтверждения `ок продажа`."
        )
        first_item = await get_next_unpriced_spec_item(int(spec_document_id))
        if first_item:
            await update.message.reply_text(_spec_item_account_prompt(first_item))
    else:
        await update.message.reply_text(
            "Не увидел итоговую сумму продажи в спецификации.\n"
            "Напишите сумму продажи числом (например `132000`)."
        )


async def _save_spec_purchase_operations(
    *,
    session: dict,
    created_by: str,
) -> tuple[list[int], int | None, float]:
    spec_document_id = int(session["spec_document_id"])
    spec_document = await get_spec_document_by_id(spec_document_id)
    if not spec_document:
        raise ValueError("spec_document_not_found")

    items = await list_spec_items(spec_document_id)
    order = await get_order_by_id(int(session["order_id"]))
    if not order:
        raise ValueError("order_not_found")

    operation_ids: list[int] = []
    total_cogs = 0.0
    now_date = datetime.now().date().isoformat()

    for item in items:
        purchase_price = float(item.get("purchase_price") or 0.0)
        item_account = str(item.get("purchase_account") or "").strip()
        if purchase_price <= 0:
            raise ValueError("spec_item_without_price")
        if not item_account:
            raise ValueError("spec_item_without_account")
        total_cogs += purchase_price
        payment_source, payment_method = _spec_payment_meta(item_account)
        description = (
            f"{int(item.get('item_index') or 0)}. "
            f"{item.get('component_name')}: {item.get('component_value')}"
        )
        operation_id = await add_operation(
            date=now_date,
            operation_type="закупка",
            description=description,
            amount=purchase_price,
            created_by=created_by,
            expense_category="Комплектующие",
            expense_subcategory=_spec_category_for_component(str(item.get("component_name") or "")),
            expense_block="Себестоимость",
            client_id=int(session["client_id"]),
            order_id=int(session["order_id"]),
            order_phone=str(order.get("order_phone") or ""),
            payment_source=payment_source,
            payment_account=item_account,
            payment_method=payment_method,
            sale_type=str(order.get("sale_type") or "Сборка"),
            business_direction=config.DEFAULT_BUSINESS_DIRECTION,
            comment=f"spec_item:{spec_document_id}:{int(item.get('id') or 0)}",
        )
        operation_ids.append(int(operation_id))

    aggregate_operation_id: int | None = None

    try:
        await setup_management_spreadsheet()
    except Exception:
        logger.warning("Could not sync sheets after spec purchase save", exc_info=True)

    return operation_ids, aggregate_operation_id, total_cogs


async def _create_text_spec_document(
    *,
    order: dict,
    parsed: dict,
    created_by: str,
) -> dict:
    latest = await get_latest_spec_document_for_order(int(order["id"]))
    version = int(latest["version"]) + 1 if latest else 1
    primary_spec = await get_primary_spec_document_for_order(int(order["id"]))
    has_working_primary = bool(primary_spec and str(primary_spec.get("parse_status") or "").lower() == "parsed")
    is_primary_spec = not has_working_primary
    spec_id = await add_spec_document(
        order_id=int(order["id"]),
        client_id=int(order["client_id"]),
        document_id=None,
        version=version,
        parse_mode="primary" if is_primary_spec else "manual_review",
        parse_status="parsed" if is_primary_spec else "manual_review",
        source_file_name="text_spec_message",
        source_file_path="telegram://text",
        extracted_payload=json.dumps(parsed, ensure_ascii=False),
        customer_total=float(parsed.get("customer_total") or 0) or None,
        created_by=created_by,
    )
    await add_spec_items(spec_id, list(parsed.get("items") or []))
    try:
        await setup_management_spreadsheet()
    except Exception:
        logger.warning("Could not sync sheets after text-spec creation", exc_info=True)
    return {
        "spec_id": int(spec_id),
        "version": int(version),
        "is_primary": bool(is_primary_spec),
    }


async def _open_or_reuse_order_for_phone(
    context: ContextTypes.DEFAULT_TYPE,
    phone: str,
    created_by: str,
    client_name: str | None,
    sale_type: str,
    force_new: bool = False,
    telegram_username: str | None = None,
) -> tuple[int, int, str]:
    """Creates/reuses order and stores active session into context."""
    client_id, _ = await get_or_create_client_by_phone(
        phone=phone,
        full_name=client_name,
        telegram_username=telegram_username,
        created_by=created_by,
    )
    latest = await get_latest_order_for_phone(phone)
    use_existing = (
        latest
        and latest.get("status") == "open"
        and not force_new
    )
    if use_existing:
        order_id = int(latest["id"])
    else:
        order_id = await create_order(
            client_id=client_id,
            order_phone=phone,
            opened_by=created_by,
            sale_type=sale_type or "Сборка",
        )

    context.user_data[ACTIVE_ORDER_ID_KEY] = order_id
    context.user_data[ACTIVE_CLIENT_ID_KEY] = client_id
    context.user_data[ACTIVE_ORDER_PHONE_KEY] = phone
    return order_id, client_id, phone


def _is_delete_confirmation_text(text: str) -> bool:
    lowered = text.strip().lower()
    if "подтверждаю удаление" in lowered:
        return True
    return lowered in {"удалить", "да удалить", "ок удалить", "confirm delete"}


def _is_delete_cancel_text(text: str) -> bool:
    lowered = text.strip().lower()
    if _is_cancel_text(text):
        return True
    return lowered in {"не удалять", "отмена удаления", "cancel delete"}


def _build_delete_confirmation_text(operation: dict) -> str:
    return (
        f"Подтвердите удаление операции #{operation['id']}:\n"
        f"{operation['date']} | {operation['operation_type']} | "
        f"{operation['amount']:,.0f} ₽ | {operation['description']}\n\n"
        "Напишите `подтверждаю удаление` или `отмена`."
    )


async def queue_delete_confirmation(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    target_id: int,
    requested_by: int,
    role: str = "owner",
    created_by: str | None = None,
) -> bool:
    operation = await get_operation_by_id(int(target_id))
    if not operation:
        await update.message.reply_text(f"Операция #{target_id} не найдена.")
        return False
    if role != "owner" and created_by and str(operation.get("created_by") or "") != created_by:
        await update.message.reply_text("Можно удалять только собственные операции.")
        return False
    context.user_data[PENDING_DELETE_KEY] = {
        "target_id": int(target_id),
        "requested_by": int(requested_by),
    }
    await update.message.reply_text(_build_delete_confirmation_text(operation))
    return True


async def _handle_pending_delete_confirmation(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    text: str,
    created_by: str,
    user_id: int,
) -> bool:
    pending_delete = context.user_data.get(PENDING_DELETE_KEY)
    if not pending_delete:
        return False

    if int(pending_delete.get("requested_by") or 0) != int(user_id):
        await update.message.reply_text("Подтвердить удаление может только пользователь, который его запросил.")
        return True

    if _is_delete_cancel_text(text):
        context.user_data.pop(PENDING_DELETE_KEY, None)
        await update.message.reply_text("Удаление отменено.")
        return True

    if not _is_delete_confirmation_text(text):
        await update.message.reply_text("Для удаления напишите `подтверждаю удаление` или `отмена`.")
        return True

    context.user_data.pop(PENDING_DELETE_KEY, None)
    target_id = int(pending_delete["target_id"])
    await _delete_operation_by_user_request(
        update,
        target_id=target_id,
        created_by=created_by,
    )
    return True


async def _queue_wipe_confirmation(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    user_id: int,
) -> None:
    context.user_data[PENDING_WIPE_KEY] = {
        "requested_by": int(user_id),
        "attempts": 0,
    }
    await update.message.reply_text(_wipe_pin_prompt())


async def _handle_pending_wipe_confirmation(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    text: str,
    user_id: int,
    first_name: str,
    role: str,
) -> bool:
    pending_wipe = context.user_data.get(PENDING_WIPE_KEY)
    if not pending_wipe:
        return False

    if int(pending_wipe.get("requested_by") or 0) != int(user_id):
        await update.message.reply_text("Подтвердить зачистку может только пользователь, который ее запросил.")
        return True

    if _is_cancel_text(text):
        context.user_data.pop(PENDING_WIPE_KEY, None)
        await _safe_audit_log(
            event_type="wipe_cancelled",
            user_id=user_id,
            first_name=first_name,
            role=role,
            command_name=config.DATA_WIPE_TRIGGER_CODE,
        )
        await update.message.reply_text("Зачистка отменена.")
        return True

    if str(text or "").strip() != config.DATA_WIPE_PIN:
        attempts = int(pending_wipe.get("attempts") or 0) + 1
        pending_wipe["attempts"] = attempts
        context.user_data[PENDING_WIPE_KEY] = pending_wipe
        await _safe_audit_log(
            event_type="wipe_pin_failed",
            user_id=user_id,
            first_name=first_name,
            role=role,
            command_name=config.DATA_WIPE_TRIGGER_CODE,
            details=f"attempt={attempts}",
        )
        if attempts >= 3:
            context.user_data.pop(PENDING_WIPE_KEY, None)
            await update.message.reply_text("Неверный PIN 3 раза подряд. Зачистка отменена.")
            return True
        await update.message.reply_text("Неверный PIN. Попробуйте еще раз или напишите `отмена`.")
        return True

    context.user_data.pop(PENDING_WIPE_KEY, None)
    await _safe_audit_log(
        event_type="wipe_confirmed",
        user_id=user_id,
        first_name=first_name,
        role=role,
        command_name=config.DATA_WIPE_TRIGGER_CODE,
    )

    counts = await wipe_all_business_data()
    sheet_status = "не синхронизирована"
    try:
        await reset_management_spreadsheet()
        sheet_status = "очищена и пересобрана"
    except FileNotFoundError:
        sheet_status = "пропущена (нет файла credentials)"
    except Exception:
        sheet_status = "ошибка обновления"
        logger.warning("Could not reset spreadsheet after wipe", exc_info=True)

    context.user_data.clear()
    context.user_data["user_role"] = role

    await _safe_audit_log(
        event_type="wipe_completed",
        user_id=user_id,
        first_name=first_name,
        role=role,
        command_name=config.DATA_WIPE_TRIGGER_CODE,
        details=f"counts={counts}",
    )

    await update.message.reply_text(
        "Зачистка выполнена.\n"
        f"Операции: {counts.get('operations', 0)}\n"
        f"Заказы: {counts.get('customer_orders', 0)}\n"
        f"Клиенты: {counts.get('clients', 0)}\n"
        f"Документы: {counts.get('documents', 0)}\n"
        f"Спецификации: {counts.get('spec_documents', 0)}\n"
        f"Позиции спецификаций: {counts.get('spec_items', 0)}\n"
        f"Логи распознавания: {counts.get('recognition_logs', 0)}\n"
        f"Google Sheets: {sheet_status}."
    )
    return True


def _is_order_phrase_with_phone(text: str) -> bool:
    lowered = text.strip().lower()
    if "заказ" not in lowered:
        return False
    return bool(_extract_phone_from_text(text))


def _build_order_action_prompt(phone: str, full_name: str | None) -> str:
    customer_name = f" ({full_name})" if full_name else ""
    return (
        f"Распознал заказ {phone}{customer_name}.\n"
        "Что сделать?\n"
        "1. Открыть карточку заказа\n"
        "2. Сразу начать сценарий продажи\n\n"
        "Ответьте `1` или `2`."
    )


async def _handle_pending_order_action(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    text: str,
    created_by: str,
    telegram_username: str | None,
) -> bool:
    pending_action = context.user_data.get(PENDING_ORDER_ACTION_KEY)
    if not pending_action:
        return False

    lowered = text.strip().lower()
    if lowered in {"1", "карточка", "открыть карточку", "только карточку"}:
        await _handle_open_order_intent(
            update=update,
            context=context,
            created_by=created_by,
            telegram_username=telegram_username,
            phone=str(pending_action["phone"]),
            full_name=pending_action.get("full_name"),
        )
        context.user_data.pop(PENDING_ORDER_ACTION_KEY, None)
        return True

    if lowered in {"2", "продажа", "сразу продажа", "начать продажу"}:
        await _handle_open_order_intent(
            update=update,
            context=context,
            created_by=created_by,
            telegram_username=telegram_username,
            phone=str(pending_action["phone"]),
            full_name=pending_action.get("full_name"),
        )
        context.user_data.pop(PENDING_ORDER_ACTION_KEY, None)
        await update.message.reply_text(
            "Отлично, заказ открыт. Теперь отправьте спецификацию или напишите продажу/операции по этому заказу."
        )
        return True

    if _is_cancel_text(text):
        context.user_data.pop(PENDING_ORDER_ACTION_KEY, None)
        await update.message.reply_text("Ок, действие по заказу отменено.")
        return True

    await update.message.reply_text("Нужно выбрать `1` или `2`.")
    return True


def _pending_preview_text(pending: dict) -> str:
    return (
        f"{format_operation_card(pending)}\n\n"
        "Ответьте `ок`, чтобы сохранить, "
        "или `исправь поле значение` (например: `исправь сумму 55000`).\n"
        "Для удаления сохраненной записи можно написать: `удали 123` или `удали последнюю`."
    )


async def _delete_operation_by_user_request(
    update: Update,
    *,
    target_id: int,
    created_by: str,
) -> bool:
    operation = await get_operation_by_id(target_id)
    if not operation:
        await update.message.reply_text(f"Операция #{target_id} не найдена.")
        return False
    if await delete_operation(target_id):
        try:
            await setup_management_spreadsheet()
        except Exception:
            logger.warning("Could not resync sheets after delete operation #%s", target_id, exc_info=True)
        await update.message.reply_text(
            f"Удалил операцию #{target_id}: {operation['description']} на {operation['amount']:,.0f} ₽"
        )
        return True
    await update.message.reply_text(f"Не удалось удалить операцию #{target_id}.")
    return False


async def _save_operation_payload(payload: dict, *, source_text: str, created_by: str) -> int:
    order_id = payload.get("order_id")
    client_id = payload.get("client_id")

    op_id = await add_operation(
        date=payload["date"],
        operation_type=payload["operation_type"],
        description=payload.get("description", ""),
        amount=payload["amount"],
        created_by=created_by,
        expense_category=payload.get("expense_category"),
        expense_subcategory=payload.get("expense_subcategory"),
        expense_block=payload.get("expense_block"),
        client_id=client_id,
        order_id=order_id,
        order_phone=payload.get("order_phone"),
        supplier=payload.get("supplier"),
        payment_source=payload.get("payment_source"),
        payment_account=payload.get("payment_account"),
        payment_method=payload.get("payment_method"),
        income_channel=payload.get("income_channel"),
        sale_type=payload.get("sale_type"),
        business_direction=payload.get("business_direction"),
        comment=payload.get("comment"),
    )

    try:
        await append_operation_to_sheet(payload, op_id)
    except Exception:
        logger.warning("Could not export operation #%s to Google Sheets", op_id, exc_info=True)

    await _log_quality_event(
        source_text=source_text,
        created_by=created_by,
        status="saved",
        parser_mode=str(payload.get("_parser_mode") or "unknown"),
        final_payload=_to_json(payload),
    )
    return op_id


async def _save_pending_operation(update: Update, context: ContextTypes.DEFAULT_TYPE):
    pending = context.user_data.get(PENDING_OPERATION_KEY)
    source_text = context.user_data.get(PENDING_SOURCE_TEXT_KEY, "")
    if not pending:
        await update.message.reply_text("Нет операции для сохранения.")
        return

    sale_block = await _sale_block_reason(pending)
    if sale_block:
        await update.message.reply_text(sale_block)
        return

    user = update.effective_user
    created_by = f"{user.id}:{user.first_name}"
    op_id = await _save_operation_payload(
        pending,
        source_text=source_text,
        created_by=created_by,
    )

    context.user_data.pop(PENDING_OPERATION_KEY, None)
    context.user_data.pop(PENDING_SOURCE_TEXT_KEY, None)
    context.user_data.pop(PENDING_MISSING_KEY, None)
    context.user_data.pop(PENDING_WAITING_ORDER_PHONE_KEY, None)

    await update.message.reply_text(f"Операция сохранена (#{op_id}).\n\n{format_operation_card(pending)}")


async def _merge_from_answer(pending: dict, source_text: str, answer_text: str) -> dict:
    """Uses parser to merge clarification into pending payload."""
    merged = dict(pending)
    correction = answer_text.strip()
    lower = correction.lower()

    if lower.startswith(CORRECTION_PREFIX):
        # Fast manual correction flow.
        match = re.match(r"исправь\s+([^\s]+)\s+(.+)$", lower, re.IGNORECASE)
        if match:
            field_alias, raw_value = match.group(1), correction.split(maxsplit=2)[2]
            alias_map = {
                "сумму": "amount",
                "сумма": "amount",
                "тип": "operation_type",
                "описание": "description",
                "поставщик": "supplier",
                "категория": "expense_category",
                "подкатегория": "expense_subcategory",
                "счет": "payment_account",
                "канал": "income_channel",
                "дата": "date",
                "телефон": "client_phone",
                "заказ": "client_phone",
                "клиента": "client_name",
            }
            field = alias_map.get(field_alias)
            if field == "amount":
                try:
                    merged["amount"] = float(raw_value.replace(" ", "").replace(",", "."))
                except ValueError:
                    pass
            elif field == "operation_type":
                merged["operation_type"] = raw_value.strip().lower()
            elif field == "date":
                merged["date"] = raw_value.strip()
                merged["_invalid_date"] = False
            elif field == "client_phone":
                merged["client_phone"] = normalize_phone(raw_value)
            elif field:
                merged[field] = raw_value.strip()
        merged["_confidence"] = max(float(merged.get("_confidence", 0.75)), 0.8)

    parsed = await ai_parser.parse_operation(f"{source_text}\nУточнение: {answer_text}")
    if parsed:
        for key in (
            "amount",
            "operation_type",
            "description",
            "supplier",
            "expense_category",
            "expense_subcategory",
            "expense_block",
            "client_name",
            "client_phone",
            "payment_source",
            "payment_account",
            "payment_method",
            "business_direction",
            "income_channel",
            "sale_type",
            "date",
            "comment",
            "_confidence",
            "_clarify_question",
            "_invalid_date",
        ):
            if key == "amount" and parsed.get("amount"):
                merged["amount"] = parsed["amount"]
            elif key == "_invalid_date":
                merged[key] = bool(parsed.get(key))
            elif parsed.get(key):
                merged[key] = parsed[key]

    return _normalize_parsed_data(merged)


async def _merge_from_answer_v2(pending: dict, source_text: str, answer_text: str) -> dict:
    """
    Mixed clarification strategy:
    - simple field fixes are applied locally;
    - complex clarifications are delegated to AI parse.
    """
    merged = dict(pending)
    correction = answer_text.strip()
    lower = correction.lower()
    should_use_ai = True

    if lower.startswith(CORRECTION_PREFIX):
        match = re.match(rf"{re.escape(CORRECTION_PREFIX)}\s+([^\s]+)\s+(.+)$", lower, re.IGNORECASE)
        if match:
            field_alias = match.group(1)
            raw_value = correction.split(maxsplit=2)[2]
            alias_map = {
                "сумму": "amount",
                "сумма": "amount",
                "тип": "operation_type",
                "описание": "description",
                "поставщик": "supplier",
                "категория": "expense_category",
                "подкатегория": "expense_subcategory",
                "счет": "payment_account",
                "канал": "income_channel",
                "дата": "date",
                "телефон": "client_phone",
                "заказ": "client_phone",
                "клиента": "client_name",
            }
            field = alias_map.get(field_alias)
            simple_fields = {
                "amount",
                "operation_type",
                "date",
                "payment_account",
                "income_channel",
                "client_phone",
                "expense_subcategory",
            }

            if field == "amount":
                try:
                    merged["amount"] = float(raw_value.replace(" ", "").replace(",", "."))
                except ValueError:
                    pass
                else:
                    should_use_ai = False
            elif field == "operation_type":
                merged["operation_type"] = raw_value.strip().lower()
                should_use_ai = False
            elif field == "date":
                merged["date"] = raw_value.strip()
                merged["_invalid_date"] = False
                should_use_ai = False
            elif field == "client_phone":
                merged["client_phone"] = normalize_phone(raw_value)
                should_use_ai = False
            elif field in simple_fields:
                merged[field] = raw_value.strip()
                should_use_ai = False
            elif field:
                merged[field] = raw_value.strip()
        merged["_confidence"] = max(float(merged.get("_confidence", 0.75)), 0.82)

    if should_use_ai:
        parsed = await ai_parser.parse_operation(f"{source_text}\nУточнение: {answer_text}")
        if parsed:
            for key in (
                "amount",
                "operation_type",
                "description",
                "supplier",
                "expense_category",
                "expense_subcategory",
                "expense_block",
                "client_name",
                "client_phone",
                "payment_source",
                "payment_account",
                "payment_method",
                "business_direction",
                "income_channel",
                "sale_type",
                "date",
                "comment",
                "_confidence",
                "_clarify_question",
                "_invalid_date",
            ):
                if key == "amount" and parsed.get("amount"):
                    merged["amount"] = parsed["amount"]
                elif key == "_invalid_date":
                    merged[key] = bool(parsed.get(key))
                elif parsed.get(key):
                    merged[key] = parsed[key]

    return _normalize_parsed_data(merged)


async def _attach_order_if_needed(
    pending: dict,
    context: ContextTypes.DEFAULT_TYPE,
    created_by: str,
    telegram_username: str | None,
    source_text: str,
    force_new_order: bool = False,
) -> tuple[dict, bool]:
    """
    Ensures pending payload has order if needed.

    Returns (pending, waiting_for_phone).
    """
    operation_type = str(pending.get("operation_type") or "").strip().lower()
    if not _operation_needs_order(
        pending,
        source_text=source_text,
        has_active_order=bool(context.user_data.get(ACTIVE_ORDER_ID_KEY)),
    ):
        return pending, False

    active_order_id = context.user_data.get(ACTIVE_ORDER_ID_KEY)
    if active_order_id:
        order = await get_order_by_id(int(active_order_id))
        if order and order.get("status") == "open":
            pending["order_id"] = int(order["id"])
            pending["client_id"] = int(order["client_id"])
            pending["order_phone"] = order.get("order_phone") or order.get("client_phone")
            if not pending.get("client_name"):
                pending["client_name"] = order.get("client_name")
            return pending, False

    phone = pending.get("client_phone")
    if not phone:
        return pending, True

    order_id, client_id, normalized_phone = await _open_or_reuse_order_for_phone(
        context=context,
        phone=phone,
        created_by=created_by,
        client_name=pending.get("client_name"),
        sale_type=pending.get("sale_type") or "Сборка",
        force_new=force_new_order or operation_type == "продажа",
        telegram_username=telegram_username,
    )
    pending["order_id"] = order_id
    pending["client_id"] = client_id
    pending["order_phone"] = normalized_phone
    return pending, False


async def _handle_multi_operations(
    *,
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    processing_msg,
    source_text: str,
    parsed_operations: list[dict],
    created_by: str,
    telegram_username: str | None,
) -> None:
    prepared_operations: list[dict] = []
    for index, parsed in enumerate(parsed_operations, start=1):
        normalized = _normalize_parsed_data(parsed)
        normalized, waiting_for_phone = await _attach_order_if_needed(
            normalized,
            context,
            created_by,
            telegram_username,
            source_text=normalized.get("description") or source_text,
            force_new_order=normalized.get("operation_type") == "продажа",
        )
        missing = _missing_fields(normalized)

        if waiting_for_phone or missing:
            context.user_data[PENDING_OPERATION_KEY] = normalized
            context.user_data[PENDING_SOURCE_TEXT_KEY] = source_text
            context.user_data[PENDING_WAITING_ORDER_PHONE_KEY] = waiting_for_phone
            context.user_data[PENDING_MISSING_KEY] = missing

            await _log_quality_event(
                source_text=source_text,
                created_by=created_by,
                status="parsed_pending",
                parser_mode=str(normalized.get("_parser_mode") or "unknown"),
                parsed_payload=_to_json(normalized),
            )

            if waiting_for_phone:
                await processing_msg.edit_text(
                    f"В сообщении несколько операций. Для операции #{index} нужен телефон заказа (пример: +79991234567)."
                )
                return
            await processing_msg.edit_text(_question_for(missing[0], normalized))
            return

        sale_block = await _sale_block_reason(normalized)
        if sale_block:
            await processing_msg.edit_text(
                "Не смог сохранить операции из одного сообщения.\n" + sale_block
            )
            return

        prepared_operations.append(normalized)

    saved_blocks: list[str] = []
    for normalized in prepared_operations:
        operation_id = await _save_operation_payload(
            normalized,
            source_text=source_text,
            created_by=created_by,
        )
        saved_blocks.append(f"#{operation_id}\n{format_operation_card(normalized)}")

    await processing_msg.edit_text(
        f"Сохранил {len(saved_blocks)} операции из одного сообщения.\n\n" + "\n\n".join(saved_blocks)
    )


async def _handle_pending_spec_pricing(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    text: str,
    created_by: str,
) -> bool:
    sale_session = context.user_data.get(PENDING_SPEC_SALE_KEY)
    if sale_session and sale_session.get("awaiting_amount"):
        return False

    session = context.user_data.get(PENDING_SPEC_PRICING_KEY)
    if not session:
        return False

    spec_document_id = int(session.get("spec_document_id") or 0)
    if not spec_document_id:
        context.user_data.pop(PENDING_SPEC_PRICING_KEY, None)
        return False

    lowered = text.strip().lower()
    sale_confirm_words = {"ок продажа", "ок, продажа", "подтверждаю продажу", "сохрани продажу"}

    if session.get("awaiting_receipt"):
        receipts_count = await count_order_receipts(int(session["order_id"]))
        if receipts_count > 0 and (_is_confirmation_text(text) or "чек" in lowered):
            context.user_data.pop(PENDING_SPEC_PRICING_KEY, None)
            if context.user_data.get(PENDING_SPEC_SALE_KEY):
                await update.message.reply_text("Чек принят. Теперь подтвердите продажу: `ок продажа`.")
            else:
                await update.message.reply_text("Чек принят. Сценарий заказа завершен.")
            return True
        await update.message.reply_text(
            "Загрузите хотя бы один чек по закупке в этот заказ.\n"
            "После загрузки напишите `чек загружен`."
        )
        return True

    if session.get("awaiting_finalize"):
        if _is_confirmation_text(text) or lowered in {"ок закупка", "сохрани закупку"}:
            try:
                operation_ids, aggregate_id, cogs_amount = await _save_spec_purchase_operations(
                    session=session,
                    created_by=created_by,
                )
            except ValueError:
                context.user_data.pop(PENDING_SPEC_PRICING_KEY, None)
                await update.message.reply_text("Не смог завершить сохранение закупок по спецификации.")
                return True

            receipts_count = await count_order_receipts(int(session["order_id"]))
            if receipts_count <= 0:
                session["awaiting_receipt"] = True
                session["awaiting_finalize"] = False
                context.user_data[PENDING_SPEC_PRICING_KEY] = session
                await update.message.reply_text(
                    f"Закупки сохранены ({len(operation_ids)} позиций), но нужно прикрепить хотя бы один чек.\n"
                    "Загрузите чек файлом и напишите `чек загружен`."
                )
                return True

            context.user_data.pop(PENDING_SPEC_PRICING_KEY, None)
            if aggregate_id:
                await update.message.reply_text(
                    f"Закупки по спецификации сохранены: {len(operation_ids)} строк + тех. итог "
                    f"(#{aggregate_id}) на {cogs_amount:,.0f} ₽."
                )
            else:
                await update.message.reply_text(
                    f"Закупки по спецификации сохранены: {len(operation_ids)} строк."
                )
            await update.message.reply_text(_spec_receipts_reminder_text())
            if context.user_data.get(PENDING_SPEC_SALE_KEY):
                await update.message.reply_text("Теперь подтвердите продажу: `ок продажа`.")
            return True

        await update.message.reply_text("Чтобы завершить, напишите `ок`.")
        return True

    if session.get("awaiting_loss_confirm"):
        if SPEC_LOSS_CONFIRM_PHRASE in lowered:
            session["awaiting_loss_confirm"] = False
            session["awaiting_finalize"] = True
            context.user_data[PENDING_SPEC_PRICING_KEY] = session
            await update.message.reply_text("Убыток подтвержден. Напишите `ок`, чтобы сохранить закупки.")
            return True
        await update.message.reply_text(
            "Себестоимость не меньше продажи. Для продолжения напишите `подтверждаю убыток`."
        )
        return True

    if lowered in sale_confirm_words and context.user_data.get(PENDING_SPEC_SALE_KEY):
        await update.message.reply_text(
            "Сначала завершите ввод цен по комплектующим и подтвердите закупку (`ок`). "
            "После этого сохраните продажу (`ок продажа`)."
        )
        return True

    current_item = await get_next_unpriced_spec_item(spec_document_id)
    if not current_item:
        unpriced_left = await count_unpriced_spec_items(spec_document_id)
        if unpriced_left > 0:
            await update.message.reply_text(
                f"Нельзя завершить: не заполнены цены по {unpriced_left} позициям."
            )
            return True

        spec_document = await get_spec_document_by_id(spec_document_id)
        items = await list_spec_items(spec_document_id)
        cogs_amount = sum(float(item.get("purchase_price") or 0.0) for item in items)
        sale_amount = float(spec_document.get("customer_total") or 0.0) if spec_document else 0.0
        financials = _spec_financials(sale_amount=sale_amount, cogs_amount=cogs_amount)
        session["awaiting_finalize"] = True
        if sale_amount > 0 and cogs_amount >= sale_amount:
            session["awaiting_loss_confirm"] = True
        context.user_data[PENDING_SPEC_PRICING_KEY] = session

        message = _spec_financial_summary_text(financials)
        if session.get("awaiting_loss_confirm"):
            await update.message.reply_text(
                message + "\n\nСебестоимость не меньше продажи. Напишите `подтверждаю убыток`."
            )
            return True
        await update.message.reply_text(message + "\n\nНапишите `ок`, чтобы сохранить закупки.")
        return True

    current_item_id = int(current_item["id"])
    selected_item_id = int(session.get("current_item_id") or 0)
    selected_account = str(session.get("current_item_account") or "").strip()
    if selected_item_id != current_item_id:
        session["current_item_id"] = current_item_id
        session["current_item_account"] = None
        selected_account = ""
        context.user_data[PENDING_SPEC_PRICING_KEY] = session

    if not selected_account:
        account = _resolve_spec_purchase_account(text)
        if not account:
            await update.message.reply_text(_spec_item_account_prompt(current_item))
            return True
        session["current_item_account"] = account
        context.user_data[PENDING_SPEC_PRICING_KEY] = session
        await update.message.reply_text(_spec_item_price_prompt(current_item, account))
        return True

    amount = _extract_single_amount(text)
    if amount is None:
        await update.message.reply_text(
            "Не вижу сумму. Отправьте число (например `18500`)."
        )
        return True

    await update_spec_item_price(
        int(current_item["id"]),
        float(amount),
        status="confirmed",
        purchase_account=selected_account,
    )
    session["current_item_id"] = None
    session["current_item_account"] = None
    context.user_data[PENDING_SPEC_PRICING_KEY] = session
    next_item = await get_next_unpriced_spec_item(spec_document_id)
    if next_item:
        await update.message.reply_text(
            f"Сохранил: {float(amount):,.0f} ₽.\n" + _spec_item_account_prompt(next_item)
        )
        return True

    spec_document = await get_spec_document_by_id(spec_document_id)
    items = await list_spec_items(spec_document_id)
    cogs_amount = sum(float(item.get("purchase_price") or 0.0) for item in items)
    sale_amount = float(spec_document.get("customer_total") or 0.0) if spec_document else 0.0
    financials = _spec_financials(sale_amount=sale_amount, cogs_amount=cogs_amount)
    session["awaiting_finalize"] = True
    if sale_amount > 0 and cogs_amount >= sale_amount:
        session["awaiting_loss_confirm"] = True
    context.user_data[PENDING_SPEC_PRICING_KEY] = session

    message = _spec_financial_summary_text(financials)
    if session.get("awaiting_loss_confirm"):
        await update.message.reply_text(
            message + "\n\nСебестоимость не меньше продажи. Напишите `подтверждаю убыток`."
        )
        return True
    await update.message.reply_text(message + "\n\nНапишите `ок`, чтобы сохранить закупки.")
    return True


async def _handle_pending_spec_sale(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    text: str,
    created_by: str,
) -> bool:
    session = context.user_data.get(PENDING_SPEC_SALE_KEY)
    if not session:
        return False

    lowered = text.strip().lower()
    if session.get("awaiting_amount"):
        amount = _extract_single_amount(text)
        if amount is None:
            await update.message.reply_text(
                "Не вижу сумму продажи. Напишите число (например `132000`)."
            )
            return True
        session["amount"] = float(amount)
        session["awaiting_amount"] = False
        session["allow_incomplete_confirmed"] = False
        context.user_data[PENDING_SPEC_SALE_KEY] = session
        await update.message.reply_text(
            f"Сумма продажи сохранена: {float(amount):,.0f} ₽.\n"
            "Теперь укажите счета и цены всех комплектующих."
        )
        return True

    if lowered in {"пропустить", "не надо", "skip"}:
        context.user_data.pop(PENDING_SPEC_SALE_KEY, None)
        await update.message.reply_text("Ок, автосохранение продажи по спецификации пропущено.")
        return True

    sale_confirm_words = {"ок", "ok", "ок продажа", "ок, продажа", "подтверждаю продажу", "сохрани продажу"}
    force_partial_phrase = "подтверждаю без себестоимости"
    if lowered not in sale_confirm_words and force_partial_phrase not in lowered:
        return False

    order = await get_order_by_id(int(session["order_id"]))
    if not order:
        context.user_data.pop(PENDING_SPEC_SALE_KEY, None)
        await update.message.reply_text("Не нашел активный заказ для сохранения продажи по спецификации.")
        return True

    payload = {
        "date": datetime.now().date().isoformat(),
        "operation_type": "продажа",
        "description": str(session.get("description") or "Продажа по спецификации").strip(),
        "amount": float(session.get("amount") or 0.0),
        "expense_category": None,
        "expense_subcategory": None,
        "expense_block": None,
        "order_id": int(session["order_id"]),
        "client_id": int(session["client_id"]),
        "order_phone": str(order.get("order_phone") or ""),
        "supplier": None,
        "payment_source": "корп",
        "payment_account": config.DEFAULT_PAYMENT_ACCOUNTS[0],
        "payment_method": "карта",
        "income_channel": "Онлайн",
        "sale_type": str(session.get("sale_type") or "Сборка"),
        "business_direction": config.DEFAULT_BUSINESS_DIRECTION,
        "comment": f"auto_from_spec:{session.get('spec_document_id')}",
        "_parser_mode": "spec_auto_sale",
        "_confidence": 1.0,
    }

    primary_spec = await get_primary_spec_document_for_order(int(session["order_id"]))
    if not primary_spec or str(primary_spec.get("parse_status") or "").lower() != "parsed":
        await update.message.reply_text(
            "Продажу по заказу нельзя сохранить без рабочей спецификации.\n"
            "Сначала пришлите спецификацию."
        )
        return True

    unpriced = await count_unpriced_spec_items(int(primary_spec["id"]))
    if unpriced > 0 and force_partial_phrase not in lowered:
        session["allow_incomplete_confirmed"] = True
        context.user_data[PENDING_SPEC_SALE_KEY] = session
        await update.message.reply_text(
            f"Внимание: не заполнены цены по {unpriced} комплектующим.\n"
            "Если хотите сохранить продажу сейчас, напишите: `подтверждаю без себестоимости`.\n"
            "Или продолжите ввод цен комплектующих."
        )
        return True

    operation_id = await _save_operation_payload(
        payload,
        source_text=f"spec_auto_sale:{session.get('spec_document_id')}",
        created_by=created_by,
    )
    context.user_data.pop(PENDING_SPEC_SALE_KEY, None)
    await update.message.reply_text(
        f"Продажа по спецификации сохранена (#{operation_id}) на {payload['amount']:,.0f} ₽."
    )
    return True


async def handle_text_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handles free-form user text with parse -> clarify -> soft-confirm -> save flow."""
    text = (update.message.text or "").strip()
    if not text:
        return

    user = update.effective_user
    created_by = f"{user.id}:{user.first_name}"
    telegram_username = f"@{user.username}" if user.username else None
    role = _context_role(context)

    handled_wipe_confirmation = await _handle_pending_wipe_confirmation(
        update,
        context,
        text=text,
        user_id=int(user.id),
        first_name=str(user.first_name or ""),
        role=role,
    )
    if handled_wipe_confirmation:
        return

    if _is_wipe_trigger_text(text):
        if role != "owner":
            await _safe_audit_log(
                event_type="wipe_denied",
                user_id=int(user.id),
                first_name=str(user.first_name or ""),
                role=role,
                command_name=config.DATA_WIPE_TRIGGER_CODE,
                details="operator_role",
            )
            await update.message.reply_text("Команда зачистки доступна только роли owner.")
            return
        await _safe_audit_log(
            event_type="wipe_requested",
            user_id=int(user.id),
            first_name=str(user.first_name or ""),
            role=role,
            command_name=config.DATA_WIPE_TRIGGER_CODE,
        )
        await _queue_wipe_confirmation(update, context, user_id=int(user.id))
        return

    handled_spec_pricing = await _handle_pending_spec_pricing(update, context, text, created_by)
    if handled_spec_pricing:
        return

    handled_spec_sale = await _handle_pending_spec_sale(update, context, text, created_by)
    if handled_spec_sale:
        return

    handled_delete_confirmation = await _handle_pending_delete_confirmation(
        update,
        context,
        text=text,
        created_by=created_by,
        user_id=update.effective_user.id,
    )
    if handled_delete_confirmation:
        return

    handled_order_action = await _handle_pending_order_action(
        update,
        context,
        text=text,
        created_by=created_by,
        telegram_username=telegram_username,
    )
    if handled_order_action:
        return

    pending = context.user_data.get(PENDING_OPERATION_KEY)
    if pending:
        delete_id = _extract_delete_operation_id(text)
        if delete_id is not None:
            context.user_data.pop(PENDING_OPERATION_KEY, None)
            context.user_data.pop(PENDING_SOURCE_TEXT_KEY, None)
            context.user_data.pop(PENDING_MISSING_KEY, None)
            context.user_data.pop(PENDING_WAITING_ORDER_PHONE_KEY, None)
            if delete_id == -1:
                last_op = await get_last_operation(created_by=None if role == "owner" else created_by)
                if not last_op:
                    await update.message.reply_text("Черновик отменен. Сохраненных операций для удаления нет.")
                    return
                await queue_delete_confirmation(
                    update,
                    context,
                    target_id=int(last_op["id"]),
                    requested_by=update.effective_user.id,
                    role=role,
                    created_by=created_by,
                )
                return
            await queue_delete_confirmation(
                update,
                context,
                target_id=int(delete_id),
                requested_by=update.effective_user.id,
                role=role,
                created_by=created_by,
            )
            return

        wants_delete_card = _is_delete_card_intent(text)
        if _is_cancel_text(text):
            await _log_quality_event(
                source_text=context.user_data.get(PENDING_SOURCE_TEXT_KEY, ""),
                created_by=created_by,
                status="cancelled",
                parser_mode=str(pending.get("_parser_mode") or "unknown"),
                final_payload=_to_json(pending),
            )
            context.user_data.pop(PENDING_OPERATION_KEY, None)
            context.user_data.pop(PENDING_SOURCE_TEXT_KEY, None)
            context.user_data.pop(PENDING_MISSING_KEY, None)
            context.user_data.pop(PENDING_WAITING_ORDER_PHONE_KEY, None)
            if wants_delete_card:
                await _handle_delete_card_intent(update, context)
            else:
                await update.message.reply_text("Операция отменена.")
            return

        if context.user_data.get(PENDING_WAITING_ORDER_PHONE_KEY):
            phone = _extract_phone_from_text(text)
            if not phone:
                await update.message.reply_text("Не увидел телефон заказа. Пример: +79991234567")
                return

            pending["client_phone"] = phone
            pending, waiting = await _attach_order_if_needed(
                pending,
                context,
                created_by,
                telegram_username,
                source_text=context.user_data.get(PENDING_SOURCE_TEXT_KEY, "") or pending.get("description", ""),
                force_new_order=pending.get("operation_type") == "продажа",
            )
            context.user_data[PENDING_OPERATION_KEY] = pending
            context.user_data[PENDING_WAITING_ORDER_PHONE_KEY] = waiting
            if waiting:
                await update.message.reply_text("Нужен телефон заказа.")
                return
            await update.message.reply_text(_pending_preview_text(pending))
            return

        if _is_confirmation_text(text):
            missing = _missing_fields(pending)
            if missing:
                await update.message.reply_text(_question_for(missing[0], pending))
                return
            await _save_pending_operation(update, context)
            return

        source_text = context.user_data.get(PENDING_SOURCE_TEXT_KEY, "")
        pending = await _merge_from_answer_v2(pending, source_text, text)
        pending, waiting_for_phone = await _attach_order_if_needed(
            pending,
            context,
            created_by,
            telegram_username,
            source_text=source_text or pending.get("description", ""),
            force_new_order=pending.get("operation_type") == "продажа",
        )
        context.user_data[PENDING_OPERATION_KEY] = pending
        context.user_data[PENDING_WAITING_ORDER_PHONE_KEY] = waiting_for_phone

        missing = _missing_fields(pending)
        context.user_data[PENDING_MISSING_KEY] = missing

        await _log_quality_event(
            source_text=source_text,
            created_by=created_by,
            status="clarified",
            parser_mode=str(pending.get("_parser_mode") or "unknown"),
            final_payload=_to_json(pending),
            correction_text=text,
        )

        if waiting_for_phone:
            await update.message.reply_text("Укажите телефон заказа (пример: +79991234567).")
            return
        if missing:
            await update.message.reply_text(_question_for(missing[0], pending))
            return
        sale_block = await _sale_block_reason(pending)
        if sale_block:
            await update.message.reply_text(sale_block)
            return

        await update.message.reply_text(_pending_preview_text(pending))
        return

    delete_id = _extract_delete_operation_id(text)
    if delete_id is not None:
        if delete_id == -1:
            last_op = await get_last_operation(created_by=None if role == "owner" else created_by)
            if not last_op:
                await update.message.reply_text("Не нашел последнюю вашу операцию для удаления.")
                return
            await queue_delete_confirmation(
                update,
                context,
                target_id=int(last_op["id"]),
                requested_by=update.effective_user.id,
                role=role,
                created_by=created_by,
            )
            return
        await queue_delete_confirmation(
            update,
            context,
            target_id=int(delete_id),
            requested_by=update.effective_user.id,
            role=role,
            created_by=created_by,
        )
        return

    intent_payload = await ai_parser.parse_user_intent(text)
    intent = str(intent_payload.get("intent") or "other")
    try:
        intent_confidence = float(intent_payload.get("confidence") or 0.0)
    except (TypeError, ValueError):
        intent_confidence = 0.0

    if intent_confidence >= MIN_INTENT_CONFIDENCE and intent == "open_order":
        phone = intent_payload.get("phone") or _extract_phone_from_text(text)
        if phone and _is_order_phrase_with_phone(text):
            context.user_data[PENDING_ORDER_ACTION_KEY] = {
                "phone": phone,
                "full_name": intent_payload.get("full_name"),
            }
            await update.message.reply_text(_build_order_action_prompt(phone, intent_payload.get("full_name")))
            return

    if intent_confidence >= MIN_INTENT_CONFIDENCE and intent in {
        "open_order",
        "close_order",
        "show_card",
        "delete_card",
        "delete_operation",
        "cancel_pending",
    }:
        handled = await _handle_intent_fallback_v2(
            update=update,
            context=context,
            created_by=created_by,
            telegram_username=telegram_username,
            text=text,
            intent_payload=intent_payload,
            role=role,
        )
        if handled:
            return

    active_order_id = context.user_data.get(ACTIVE_ORDER_ID_KEY)
    if active_order_id and looks_like_spec_text(text):
        order = await get_order_by_id(int(active_order_id))
        if order and order.get("status") == "open":
            await update.message.reply_text("Распознаю техническую спецификацию...")
            parsed_spec = await parse_spec_text(text)
            items = list(parsed_spec.get("items") or [])
            if not items:
                await update.message.reply_text(
                    "Не смог извлечь комплектующие из текста. Добавьте блок `Техническая спецификация` и пришлите снова."
                )
                return

            spec_meta = await _create_text_spec_document(
                order=order,
                parsed=parsed_spec,
                created_by=created_by,
            )
            customer_total = float(parsed_spec.get("customer_total") or 0.0) or None
            await update.message.reply_text(
                f"Спецификация сохранена (#{spec_meta['spec_id']}, версия {spec_meta['version']}). Позиций: {len(items)}."
            )
            if spec_meta["is_primary"]:
                await _start_spec_session(
                    update,
                    context,
                    order=order,
                    spec_document_id=spec_meta["spec_id"],
                    customer_total=customer_total,
                    source_name="текстового блока",
                )
            else:
                await update.message.reply_text(
                    "Это повторная спецификация. Добавил в ручную проверку — "
                    "она не влияет на финансы автоматически."
                )
            return

    processing_msg = await update.message.reply_text("Понял, разбираю сообщение...")
    parsed_operations = await ai_parser.parse_operations(text)

    if not parsed_operations:
        handled = await _handle_intent_fallback_v2(
            update=update,
            context=context,
            created_by=created_by,
            telegram_username=telegram_username,
            text=text,
            intent_payload=intent_payload,
            role=role,
        )
        if handled:
            return

        await _log_quality_event(
            source_text=text,
            created_by=created_by,
            status="parse_failed",
            parser_mode="none",
        )
        if ai_parser.looks_like_financial_message(text):
            await processing_msg.edit_text(
                "Не смог распознать операцию. Напишите одним сообщением: что произошло, сумму и тип."
            )
        else:
            await processing_msg.edit_text("Это не финансовая операция.")
        return

    if len(parsed_operations) > 1:
        await _handle_multi_operations(
            update=update,
            context=context,
            processing_msg=processing_msg,
            source_text=text,
            parsed_operations=parsed_operations,
            created_by=created_by,
            telegram_username=telegram_username,
        )
        return

    parsed_data = parsed_operations[0]
    parsed_data = _normalize_parsed_data(parsed_data)
    parsed_data, waiting_for_phone = await _attach_order_if_needed(
        parsed_data,
        context,
        created_by,
        telegram_username,
        source_text=text,
        force_new_order=parsed_data.get("operation_type") == "продажа",
    )

    context.user_data[PENDING_OPERATION_KEY] = parsed_data
    context.user_data[PENDING_SOURCE_TEXT_KEY] = text
    context.user_data[PENDING_WAITING_ORDER_PHONE_KEY] = waiting_for_phone

    missing = _missing_fields(parsed_data)
    context.user_data[PENDING_MISSING_KEY] = missing

    await _log_quality_event(
        source_text=text,
        created_by=created_by,
        status="parsed_pending",
        parser_mode=str(parsed_data.get("_parser_mode") or "unknown"),
        parsed_payload=_to_json(parsed_data),
    )

    if waiting_for_phone:
        await processing_msg.edit_text("Укажите телефон заказа (пример: +79991234567).")
        return
    if missing:
        await processing_msg.edit_text(_question_for(missing[0], parsed_data))
        return
    sale_block = await _sale_block_reason(parsed_data)
    if sale_block:
        await processing_msg.edit_text(sale_block)
        return

    await processing_msg.edit_text(_pending_preview_text(parsed_data))
