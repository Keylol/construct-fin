"""AI parser for free-form financial operations with resilient fallback."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime

from openai import AsyncOpenAI

import config
from bot.services.ai_runtime import get_active_ai_model
from bot.services.database import normalize_phone

logger = logging.getLogger(__name__)

TYPE_ALIASES = {
    "продажа": "продажа",
    "продал": "продажа",
    "реализ": "продажа",
    "выручка": "продажа",
    "пришло": "продажа",
    "поступил": "продажа",
    "получил оплат": "продажа",
    "закупка": "закупка",
    "купил": "закупка",
    "покупка": "закупка",
    "заказал": "закупка",
    "оплатил поставщику": "закупка",
    "предоплат": "предоплата",
    "аванс": "предоплата",
    "постоплат": "постоплата",
    "доплат": "постоплата",
    "доплата": "постоплата",
    "остаток": "постоплата",
    "расход": "расход",
    "аренда": "расход",
    "налог": "расход",
    "банк": "расход",
    "зарплат": "расход",
    "реклама": "расход",
    "списал": "расход",
    "отдал": "расход",
}

INCOME_TYPES = {"продажа", "предоплата", "постоплата"}
SALE_TYPES = {"Сборка", "Сервис"}
INTENTS = {
    "open_order",
    "close_order",
    "show_card",
    "delete_card",
    "delete_operation",
    "cancel_pending",
    "operation_input",
    "other",
}
ORDER_CONTEXT_MARKERS = ("клиент", "заказ", "сборк", "предоплат", "доплат", "телефон")
PURCHASE_MARKERS = ("купил", "купили", "закупка", "покупка", "заказал", "заказали")
OFFICE_MARKERS = (
    "в офис",
    "для офиса",
    "офис",
    "на склад",
    "для склада",
    "на содержание",
    "на бизнес",
    "для бизнеса",
    "хозрасход",
    "хоз нужд",
)
OFFICE_CATEGORY_MARKERS = (
    "офис",
    "вода",
    "чай",
    "кофе",
    "канц",
    "бумага",
    "уборк",
    "хоз",
)
AMBIGUOUS_PURCHASE_MARKERS = (
    "монитор",
    "ноутбук",
    "ноут",
    "телефон",
    "мыш",
    "клавиат",
    "стол",
    "кресл",
    "роутер",
)
FINANCE_HINT_MARKERS = (
    "прод",
    "куп",
    "закуп",
    "расход",
    "предоплат",
    "постоплат",
    "доплат",
    "оплат",
    "аренда",
    "налог",
    "зарплат",
    "банк",
    "выручк",
    "доход",
)


def _lower(text: str | None) -> str:
    return str(text or "").strip().lower()


def _has_phone(text: str | None) -> bool:
    return bool(_extract_phone_from_text(str(text or "")))


def _is_office_opex_text(text: str) -> bool:
    lowered = _lower(text)
    return any(marker in lowered for marker in OFFICE_MARKERS)


def _is_order_related_text(text: str) -> bool:
    lowered = _lower(text)
    if _has_phone(text):
        return True
    return any(marker in lowered for marker in ORDER_CONTEXT_MARKERS)


def _is_ambiguous_purchase_text(text: str) -> bool:
    lowered = _lower(text)
    if not any(marker in lowered for marker in PURCHASE_MARKERS):
        return False
    if _is_office_opex_text(lowered) or _is_order_related_text(lowered):
        return False
    return any(marker in lowered for marker in AMBIGUOUS_PURCHASE_MARKERS)


def looks_like_financial_message(text: str) -> bool:
    lowered = _lower(text)
    if _extract_amount_from_text(text) > 0:
        return True
    return any(marker in lowered for marker in FINANCE_HINT_MARKERS)


def _parse_amount(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace(" ", "").replace(",", ".")
        try:
            return float(cleaned)
        except ValueError:
            return 0.0
    return 0.0


def _normalize_date(value: str | None) -> str | None:
    if not value:
        return None
    normalized = str(value).strip().replace("г.", "").replace("г", "").strip()
    for fmt in (
        "%Y-%m-%d",
        "%Y.%m.%d",
        "%Y/%m/%d",
        "%d.%m.%Y",
        "%d-%m-%Y",
        "%d/%m/%Y",
        "%d.%m.%y",
        "%d-%m-%y",
        "%d/%m/%y",
    ):
        try:
            return datetime.strptime(normalized, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _extract_date_token(text: str) -> str | None:
    match = re.search(r"\b(\d{1,4}[./-]\d{1,2}[./-]\d{1,4})\b", str(text or ""))
    if not match:
        return None
    return match.group(1)


def _normalize_operation_type(value: str | None, text: str) -> str:
    raw = (value or "").strip().lower()
    if raw in config.OPERATION_TYPES:
        return raw

    if _is_office_opex_text(text):
        return "расход"

    source = f"{raw} {text.lower()}"
    for key, mapped in TYPE_ALIASES.items():
        if key in source:
            return mapped

    if any(marker in source for marker in PURCHASE_MARKERS):
        return "закупка"
    return "расход"


def _normalize_sale_type(value: str | None, text: str) -> str:
    raw = (value or "").strip().title()
    if raw in SALE_TYPES:
        return raw
    if "сервис" in text.lower():
        return "Сервис"
    return "Сборка"


def _normalize_income_channel(value: str | None, text: str, operation_type: str) -> str | None:
    if operation_type not in INCOME_TYPES:
        return None
    source = f"{value or ''} {text}".lower()
    if "налич" in source:
        return "Наличные"
    return "Онлайн"


def _extract_phone_from_text(text: str) -> str | None:
    for match in re.findall(r"(?:\+7|8)?[\d\-\s()]{10,20}", text):
        digits = re.sub(r"\D+", "", match)
        if len(digits) in {10, 11}:
            normalized = normalize_phone(match)
            if normalized:
                return normalized
    return None


def _remove_date_and_phone_like_tokens(text: str) -> str:
    cleaned = str(text or "")
    cleaned = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", " ", cleaned)
    cleaned = re.sub(r"\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b", " ", cleaned)
    cleaned = re.sub(r"(?:\+7|8)?[\d\-\s()]{10,20}", " ", cleaned)
    return cleaned


def _candidate_amounts(text: str) -> list[float]:
    candidates: list[float] = []
    pattern = re.compile(
        r"(?P<num>\d[\d\s]*(?:[.,]\d+)?)\s*(?P<thousand>[кk]|тыс|тысяч)?\s*(?P<currency>₽|р\b|руб)?",
        flags=re.IGNORECASE,
    )
    for match in pattern.finditer(text):
        raw_num = match.group("num")
        if not raw_num:
            continue
        value = _parse_amount(raw_num)
        thousand_suffix = (match.group("thousand") or "").lower()
        currency = (match.group("currency") or "").lower()
        span_start, _ = match.span()
        prefix = text[max(0, span_start - 8):span_start].lower()
        explicit_money_context = bool(re.search(r"(?:^|\s)(за|на|по)\s*$", prefix))

        if thousand_suffix in {"к", "k", "тыс", "тысяч"}:
            value *= 1000

        # Ignore tiny numbers unless they clearly denote money.
        if value < 1000 and not currency and not thousand_suffix and not explicit_money_context:
            continue
        if 0 < value < 100_000_000:
            candidates.append(value)
    return candidates


def _extract_amount_from_text(text: str, phone: str | None = None) -> float:
    prepared_text = _remove_date_and_phone_like_tokens(text)
    if phone:
        phone_digits = re.sub(r"\D+", "", phone)
        if phone_digits:
            prepared_text = re.sub(phone_digits, " ", prepared_text)

    parsed = _candidate_amounts(prepared_text)
    return max(parsed) if parsed else 0.0


def _detect_supplier(text: str) -> str | None:
    text_lower = text.lower()
    for supplier in config.SUPPLIERS:
        if supplier.lower() in text_lower:
            return supplier
    return None


def _detect_expense_category(text: str) -> str | None:
    category, _ = config.normalize_expense_taxonomy(
        category=None,
        description=text,
    )
    if category:
        return category

    text_lower = text.lower()
    if _is_office_opex_text(text_lower) or any(marker in text_lower for marker in OFFICE_CATEGORY_MARKERS):
        return "Офис"
    return None


def _detect_expense_subcategory(category: str | None, text: str) -> str | None:
    _, subcategory = config.normalize_expense_taxonomy(
        category=category,
        description=text,
    )
    return subcategory


def _extract_client_name(text: str) -> str | None:
    match = re.search(
        r"(?:клиент(?:у|а)?|для|по заказу)\s+([A-Za-zА-Яа-яЁё0-9_-]{2,})",
        text,
        re.IGNORECASE,
    )
    if not match:
        return None
    return match.group(1).strip().title()


def _normalize_payment_account(value: str | None, text: str, operation_type: str) -> str | None:
    direct = config.normalize_payment_account(value)
    if direct:
        return direct

    merged = config.normalize_payment_account(f"{value or ''} {text}".strip())
    if merged:
        return merged

    return config.default_payment_account_for_operation(operation_type)


def _normalize_payment_source(value: str | None, payment_account: str | None) -> str:
    raw = (value or "").strip().lower()
    if raw in config.PAYMENT_SOURCES:
        return raw
    return config.payment_source_for_account(payment_account)


def _normalize_payment_method(value: str | None, payment_account: str | None, text: str) -> str:
    raw = (value or "").strip().lower()
    if raw in config.PAYMENT_METHODS:
        return raw
    return config.payment_method_for_account(payment_account, text)


def _normalize_confidence(value, *, operation_type: str, source_text: str, client_phone: str | None) -> float:
    try:
        confidence = float(value)
    except Exception:
        confidence = 0.75

    if operation_type == "расход" and _is_office_opex_text(source_text):
        confidence = max(confidence, 0.9)

    if _is_ambiguous_purchase_text(source_text):
        confidence = min(confidence, 0.45)
    elif operation_type == "закупка" and not client_phone and not _is_order_related_text(source_text):
        confidence = max(0.65, confidence)

    if operation_type in INCOME_TYPES and not client_phone and not _is_order_related_text(source_text):
        confidence = min(confidence, 0.6)

    return max(0.0, min(confidence, 1.0))


def _clarify_question_for(normalized: dict, source_text: str) -> str | None:
    operation_type = normalized.get("operation_type")
    client_phone = normalized.get("client_phone")
    if _is_ambiguous_purchase_text(source_text):
        return "Уточните, пожалуйста: это для клиента/заказа или для офиса/бизнеса?"
    if operation_type in INCOME_TYPES and not client_phone:
        return "Уточните телефон заказа (пример: +79991234567)."
    return None


def _split_operation_chunks(text: str) -> list[str]:
    source_text = str(text or "").strip()
    if not source_text:
        return []

    line_chunks = [chunk.strip(" ,.") for chunk in re.split(r"[;\n]+", source_text) if chunk.strip(" ,.")]
    line_amount_chunks = [chunk for chunk in line_chunks if _extract_amount_from_text(chunk) > 0]
    if len(line_amount_chunks) >= 2:
        return line_amount_chunks

    if len(_candidate_amounts(_remove_date_and_phone_like_tokens(source_text))) < 2:
        return [source_text]

    and_chunks = [
        chunk.strip(" ,.")
        for chunk in re.split(r"\s+(?:и|а также|плюс)\s+", source_text, flags=re.IGNORECASE)
        if chunk.strip(" ,.")
    ]
    and_amount_chunks = [chunk for chunk in and_chunks if _extract_amount_from_text(chunk) > 0]
    if len(and_amount_chunks) >= 2:
        return and_amount_chunks

    return [source_text]


def _extract_json_payload(content: str) -> dict | None:
    normalized = (content or "").strip()
    if not normalized:
        return None

    if normalized.startswith("```json"):
        normalized = normalized[7:]
    if normalized.startswith("```"):
        normalized = normalized[3:]
    if normalized.endswith("```"):
        normalized = normalized[:-3]
    normalized = normalized.strip()

    try:
        return json.loads(normalized)
    except json.JSONDecodeError:
        pass

    first = normalized.find("{")
    last = normalized.rfind("}")
    if first != -1 and last != -1 and last > first:
        try:
            return json.loads(normalized[first : last + 1])
        except json.JSONDecodeError:
            return None
    return None


def _fallback_user_intent(text: str) -> dict:
    lowered = (text or "").strip().lower()
    phone = _extract_phone_from_text(text or "")
    op_id_match = re.search(r"\b(\d{1,10})\b", lowered)

    if any(lowered.startswith(prefix) for prefix in ("заказ", "открой заказ", "создай заказ", "новый заказ")) and phone:
        full_name = re.sub(r"(?:\+7|8)?[\d\-\s()]{10,20}", " ", text)
        for prefix in ("заказ", "открой заказ", "создай заказ", "новый заказ"):
            full_name = re.sub(rf"^\s*{re.escape(prefix)}\s*", "", full_name, flags=re.IGNORECASE)
        full_name = re.sub(r"\s+", " ", full_name).strip(" ,.-")
        return {
            "intent": "open_order",
            "phone": phone,
            "full_name": full_name or None,
            "operation_id": None,
            "delete_last": False,
            "confidence": 0.8,
            "_parser_mode": "fallback",
        }

    if any(item in lowered for item in ("закрой заказ", "закрыть заказ")):
        return {
            "intent": "close_order",
            "phone": None,
            "full_name": None,
            "operation_id": None,
            "delete_last": False,
            "confidence": 0.8,
            "_parser_mode": "fallback",
        }

    if any(item in lowered for item in ("карточка", "покажи карточку", "покажи заказ", "мой заказ")):
        return {
            "intent": "show_card",
            "phone": None,
            "full_name": None,
            "operation_id": None,
            "delete_last": False,
            "confidence": 0.8,
            "_parser_mode": "fallback",
        }

    if any(item in lowered for item in ("удали карточ", "удалить карточ", "удали клиента", "удалить клиента", "удали заказ", "удалить заказ")):
        return {
            "intent": "delete_card",
            "phone": None,
            "full_name": None,
            "operation_id": None,
            "delete_last": False,
            "confidence": 0.8,
            "_parser_mode": "fallback",
        }

    if lowered.startswith("удали") and "послед" in lowered:
        return {
            "intent": "delete_operation",
            "phone": None,
            "full_name": None,
            "operation_id": None,
            "delete_last": True,
            "confidence": 0.8,
            "_parser_mode": "fallback",
        }

    if lowered.startswith("удали") and op_id_match:
        return {
            "intent": "delete_operation",
            "phone": None,
            "full_name": None,
            "operation_id": int(op_id_match.group(1)),
            "delete_last": False,
            "confidence": 0.8,
            "_parser_mode": "fallback",
        }

    if any(item in lowered for item in ("отмена", "отмени", "не сохраняй")):
        return {
            "intent": "cancel_pending",
            "phone": None,
            "full_name": None,
            "operation_id": None,
            "delete_last": False,
            "confidence": 0.7,
            "_parser_mode": "fallback",
        }

    if _extract_amount_from_text(text or "", phone) > 0:
        return {
            "intent": "operation_input",
            "phone": phone,
            "full_name": None,
            "operation_id": None,
            "delete_last": False,
            "confidence": 0.7,
            "_parser_mode": "fallback",
        }

    return {
        "intent": "other",
        "phone": phone,
        "full_name": None,
        "operation_id": None,
        "delete_last": False,
        "confidence": 0.5,
        "_parser_mode": "fallback",
    }


def _normalize_intent_payload(raw: dict | None, source_text: str, parser_mode: str) -> dict:
    raw = raw or {}
    intent = str(raw.get("intent") or "other").strip().lower()
    if intent not in INTENTS:
        intent = "other"

    phone = normalize_phone(raw.get("phone")) or _extract_phone_from_text(source_text)
    full_name = str(raw.get("full_name") or "").strip() or None

    operation_id = raw.get("operation_id")
    try:
        operation_id = int(operation_id) if operation_id is not None else None
    except Exception:
        operation_id = None

    delete_last = bool(raw.get("delete_last"))
    confidence = raw.get("confidence")
    try:
        confidence = float(confidence)
    except Exception:
        confidence = 0.5

    return {
        "intent": intent,
        "phone": phone,
        "full_name": full_name,
        "operation_id": operation_id,
        "delete_last": delete_last,
        "confidence": max(0.0, min(confidence, 1.0)),
        "_parser_mode": parser_mode,
    }


def _normalize_result(raw: dict | None, source_text: str, parser_mode: str) -> dict | None:
    raw = raw or {}
    client_phone = normalize_phone(raw.get("client_phone")) or _extract_phone_from_text(source_text)
    operation_type = _normalize_operation_type(raw.get("operation_type"), source_text)
    payment_account = _normalize_payment_account(raw.get("payment_account"), source_text, operation_type)
    raw_date = str(raw.get("date") or "").strip() or None
    source_date = _extract_date_token(source_text)
    date_candidate = raw_date or source_date
    normalized_date = _normalize_date(date_candidate)
    invalid_date = bool(date_candidate) and not normalized_date

    normalized = {
        "operation_type": operation_type,
        "description": str(raw.get("description") or source_text).strip(),
        "amount": _parse_amount(raw.get("amount")),
        "supplier": raw.get("supplier") or _detect_supplier(source_text),
        "payment_source": _normalize_payment_source(raw.get("payment_source"), payment_account),
        "payment_account": payment_account,
        "payment_method": _normalize_payment_method(raw.get("payment_method"), payment_account, source_text),
        "business_direction": str(raw.get("business_direction") or config.DEFAULT_BUSINESS_DIRECTION).strip()
        or config.DEFAULT_BUSINESS_DIRECTION,
        "expense_category": raw.get("expense_category") or _detect_expense_category(source_text),
        "expense_subcategory": raw.get("expense_subcategory"),
        "client_name": raw.get("client_name") or _extract_client_name(source_text),
        "client_phone": client_phone,
        "date": normalized_date or ("" if invalid_date else datetime.now().date().isoformat()),
        "comment": raw.get("comment"),
        "income_channel": _normalize_income_channel(raw.get("income_channel"), source_text, operation_type),
        "sale_type": _normalize_sale_type(raw.get("sale_type"), source_text),
        "_confidence": _normalize_confidence(
            raw.get("confidence"),
            operation_type=operation_type,
            source_text=source_text,
            client_phone=client_phone,
        ),
        "_invalid_date": invalid_date,
        "_parser_mode": parser_mode,
    }
    normalized_category, normalized_subcategory = config.normalize_expense_taxonomy(
        category=normalized.get("expense_category"),
        subcategory=normalized.get("expense_subcategory"),
        description=source_text,
    )
    normalized["expense_category"] = normalized_category
    normalized["expense_subcategory"] = normalized_subcategory
    normalized["expense_block"] = config.expense_block(normalized_category)

    if normalized["amount"] <= 0:
        normalized["amount"] = _extract_amount_from_text(source_text, client_phone)
    if normalized["amount"] <= 0:
        return None
    normalized["_clarify_question"] = _clarify_question_for(normalized, source_text)
    return normalized


def _fallback_parse(text: str) -> dict | None:
    phone = _extract_phone_from_text(text)
    amount = _extract_amount_from_text(text, phone)
    if amount <= 0:
        return None

    operation_type = _normalize_operation_type(None, text)
    payment_account = _normalize_payment_account(None, text, operation_type)
    source_date = _extract_date_token(text)
    normalized_date = _normalize_date(source_date)
    invalid_date = bool(source_date) and not normalized_date
    normalized = {
        "operation_type": operation_type,
        "description": text.strip(),
        "amount": amount,
        "supplier": _detect_supplier(text),
        "payment_source": _normalize_payment_source(None, payment_account),
        "payment_account": payment_account,
        "payment_method": _normalize_payment_method(None, payment_account, text),
        "business_direction": config.DEFAULT_BUSINESS_DIRECTION,
        "expense_category": _detect_expense_category(text),
        "expense_subcategory": None,
        "client_name": _extract_client_name(text),
        "client_phone": phone,
        "date": normalized_date or ("" if invalid_date else datetime.now().date().isoformat()),
        "comment": None,
        "income_channel": _normalize_income_channel(None, text, operation_type),
        "sale_type": _normalize_sale_type(None, text),
        "_confidence": _normalize_confidence(
            None,
            operation_type=operation_type,
            source_text=text,
            client_phone=phone,
        ),
        "_invalid_date": invalid_date,
        "_parser_mode": "fallback",
    }
    normalized_category, normalized_subcategory = config.normalize_expense_taxonomy(
        category=normalized.get("expense_category"),
        subcategory=normalized.get("expense_subcategory"),
        description=text,
    )
    normalized["expense_category"] = normalized_category
    normalized["expense_subcategory"] = normalized_subcategory
    normalized["expense_block"] = config.expense_block(normalized_category)
    normalized["_clarify_question"] = _clarify_question_for(normalized, text)
    return normalized


async def parse_operation(text: str) -> dict | None:
    """
    Parses user message into structured operation.

    Returns None when AI is unavailable, fails, or cannot extract valid data.
    """
    text = (text or "").strip()
    if not text:
        return None

    if not config.GEMINI_API_KEY:
        logger.warning("GEMINI_API_KEY is not set. AI parser is disabled.")
        return None

    prompt = (
        "Извлеки финансовую операцию из сообщения и верни только JSON.\n"
        "Сообщение может быть разговорным, неполным, с жаргоном, ошибками и сокращениями (например: 35к, нал, вб, ип).\n"
        "Поля JSON: operation_type, description, amount, supplier, payment_source, payment_account, "
        "payment_method, business_direction, expense_category, expense_subcategory, client_name, client_phone, date, comment, "
        "income_channel, sale_type, confidence.\n"
        f"operation_type только из: {', '.join(config.OPERATION_TYPES)}.\n"
        f"payment_source только: {', '.join(config.PAYMENT_SOURCES)}.\n"
        f"payment_method только: {', '.join(config.PAYMENT_METHODS)}.\n"
        f"sale_type только: {', '.join(config.SALE_TYPES)}.\n"
        f"income_channel только: {', '.join(config.INCOME_CHANNELS)} или null.\n"
        f"Допустимые payment_account: {', '.join(config.DEFAULT_PAYMENT_ACCOUNTS)}.\n"
        "Для явных офисных трат (в офис/для офиса/на склад/на содержание/на бизнес) ставь operation_type='расход' и expense_category='Офис'.\n"
        "confidence от 0 до 1.\n"
        "Если поля нет в тексте, используй null. Никакого текста вне JSON.\n\n"
        f"Сообщение: {text}"
    )

    try:
        client_kwargs = {"api_key": config.GEMINI_API_KEY}
        if config.AI_BASE_URL:
            client_kwargs["base_url"] = config.AI_BASE_URL

        client = AsyncOpenAI(**client_kwargs)
        response = await client.chat.completions.create(
            model=get_active_ai_model(),
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Ты извлекаешь структурированные данные из сообщений менеджера по учету. "
                        "Возвращай строго валидный JSON без пояснений."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.1,
            timeout=20,
        )

        content = (response.choices[0].message.content or "").strip()
        parsed_payload = _extract_json_payload(content)
        normalized = _normalize_result(parsed_payload, text, parser_mode="ai")
        if normalized:
            return normalized

        logger.warning("AI response could not be normalized.")
        return None
    except Exception as exc:
        logger.error("AI parser failed: %s", exc, exc_info=True)
        return None


async def parse_operations(text: str) -> list[dict]:
    """
    Parses one or multiple financial operations from free-form text.

    Returns empty list when nothing financial is detected.
    """
    source_text = (text or "").strip()
    if not source_text:
        return []

    chunks = _split_operation_chunks(source_text)
    if len(chunks) <= 1:
        parsed = await parse_operation(source_text)
        return [parsed] if parsed else []

    parsed_operations: list[dict] = []
    for chunk in chunks:
        parsed = await parse_operation(chunk)
        if parsed:
            parsed_operations.append(parsed)

    if len(parsed_operations) >= 2:
        return parsed_operations

    parsed = await parse_operation(source_text)
    return [parsed] if parsed else []


async def parse_user_intent(text: str) -> dict:
    """
    Classifies non-structured user intents (order/card/delete/cancel).

    Returns normalized payload with keys:
    intent, phone, full_name, operation_id, delete_last, confidence, _parser_mode
    """
    text = (text or "").strip()
    if not text:
        return _normalize_intent_payload({}, "", parser_mode="none")

    if not config.GEMINI_API_KEY:
        logger.warning("GEMINI_API_KEY is not set. Intent parser is disabled.")
        return _normalize_intent_payload({}, text, parser_mode="none")

    prompt = (
        "Классифицируй намерение пользователя для Telegram-бота учета и верни только JSON.\n"
        "Возможные intent: open_order, close_order, show_card, delete_card, delete_operation, cancel_pending, operation_input, other.\n"
        "Поля JSON: intent, phone, full_name, operation_id, delete_last, confidence.\n"
        "phone в формате +79991234567 или null.\n"
        "operation_id число или null.\n"
        "delete_last true только если пользователь просит удалить последнюю операцию.\n"
        "confidence от 0 до 1.\n"
        "Никакого текста вне JSON.\n\n"
        f"Сообщение: {text}"
    )

    try:
        client_kwargs = {"api_key": config.GEMINI_API_KEY}
        if config.AI_BASE_URL:
            client_kwargs["base_url"] = config.AI_BASE_URL

        client = AsyncOpenAI(**client_kwargs)
        response = await client.chat.completions.create(
            model=get_active_ai_model(),
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Ты классифицируешь намерения пользователя для бота учета. "
                        "Возвращай только валидный JSON."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.1,
            timeout=20,
        )
        content = (response.choices[0].message.content or "").strip()
        payload = _extract_json_payload(content)
        return _normalize_intent_payload(payload, text, parser_mode="ai")
    except Exception as exc:
        logger.error("Intent parser failed: %s", exc, exc_info=True)
        return _normalize_intent_payload({}, text, parser_mode="ai_failed")
