"""Specification parser for DOCX/PDF technical sheets."""

from __future__ import annotations

import json
import logging
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from openai import AsyncOpenAI

import config
from bot.services.ai_runtime import get_active_ai_model

logger = logging.getLogger(__name__)

SPEC_CAPTION_MARKERS = ("специф", "заказ")
SPEC_MODE_REPLACE_MARKERS = ("замени", "заменить", "перезапис")
SPEC_MODE_NEW_VERSION_MARKERS = ("новая версия", "версия", "добавь версию")
SPEC_SECTION_START = ("техническая спецификация", "детали заказа")
SPEC_SECTION_END = ("гаранти", "дополнительные условия", "информация о соответствии")


def is_spec_caption(caption: str | None) -> bool:
    """Returns True when caption looks like a spec upload command."""
    lowered = str(caption or "").strip().lower()
    if not lowered:
        return False
    return any(marker in lowered for marker in SPEC_CAPTION_MARKERS)


def detect_spec_mode(caption: str | None) -> str | None:
    """Detects user decision for duplicate spec handling."""
    lowered = str(caption or "").strip().lower()
    if any(marker in lowered for marker in SPEC_MODE_REPLACE_MARKERS):
        return "replace"
    if any(marker in lowered for marker in SPEC_MODE_NEW_VERSION_MARKERS):
        return "new_version"
    return None


def looks_like_spec_text(text: str | None) -> bool:
    """Heuristic detector for pasted specification text block."""
    lowered = str(text or "").lower()
    if not lowered.strip():
        return False
    if "техническая спецификация" in lowered or "детали заказа" in lowered:
        return True
    if "заказ №" in lowered and "стоимость" in lowered:
        return True
    markers = (
        "процессор:",
        "видеокарта:",
        "материнская плата:",
        "оперативная память:",
        "основной накопитель:",
        "блок питания:",
        "корпус:",
    )
    if sum(1 for marker in markers if marker in lowered) >= 2 and "стоимость" in lowered:
        return True
    if sum(1 for marker in markers if marker in lowered) >= 4:
        return True
    return False


def _extract_docx_text(path: Path) -> str:
    with zipfile.ZipFile(path, "r") as archive:
        xml_bytes = archive.read("word/document.xml")

    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    root = ET.fromstring(xml_bytes)
    lines: list[str] = []
    for paragraph in root.findall(".//w:p", namespace):
        parts = []
        for node in paragraph.findall(".//w:t", namespace):
            if node.text:
                parts.append(node.text)
        line = "".join(parts).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _extract_pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except Exception:
        logger.warning("pypdf is not installed, PDF spec parsing is unavailable")
        return ""

    text_parts: list[str] = []
    try:
        reader = PdfReader(str(path))
    except Exception:
        logger.warning("Could not open PDF for parsing: %s", path, exc_info=True)
        return ""

    for page in reader.pages:
        try:
            extracted = page.extract_text() or ""
        except Exception:
            extracted = ""
        if extracted.strip():
            text_parts.append(extracted)
    return "\n".join(text_parts)


def _extract_spec_block_lines(text: str) -> list[str]:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    if not lines:
        return []

    start_index = 0
    for index, line in enumerate(lines):
        lowered = line.lower()
        if any(marker in lowered for marker in SPEC_SECTION_START):
            start_index = index + 1
            break

    sliced = lines[start_index:]
    result: list[str] = []
    for line in sliced:
        lowered = line.lower()
        if any(marker in lowered for marker in SPEC_SECTION_END):
            break
        result.append(line)
    return result


def _parse_amount(raw_value: str) -> float | None:
    cleaned = re.sub(r"[^\d,.\s]", "", str(raw_value or ""))
    cleaned = cleaned.replace(" ", "").replace(",", ".").strip(".")
    if not cleaned:
        return None
    try:
        value = float(cleaned)
    except ValueError:
        return None
    return value if value > 0 else None


def _extract_customer_total(text: str) -> float | None:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    best: float | None = None
    for line in lines:
        lowered = line.lower()
        if not any(marker in lowered for marker in ("итог", "к оплате", "стоимость", "цена")):
            continue
        amount_match = re.search(r"(\d[\d\s.,]{2,})", line)
        if not amount_match:
            continue
        value = _parse_amount(amount_match.group(1))
        if value is None:
            continue
        if best is None or value > best:
            best = value
    return best


def _extract_order_phone(text: str) -> str | None:
    for match in re.findall(r"(?:\+7|8)?[\d\-\s()]{10,20}", text):
        digits = re.sub(r"\D+", "", match)
        if len(digits) == 10:
            digits = "7" + digits
        if len(digits) == 11 and digits.startswith("8"):
            digits = "7" + digits[1:]
        if len(digits) == 11 and digits.startswith("7"):
            return f"+{digits}"
    return None


def _extract_customer_name(text: str) -> str | None:
    match = re.search(r"заказчик:\s*([^\n\r]+)", text, flags=re.IGNORECASE)
    if not match:
        return None
    value = re.sub(r"\(.*?\)", "", match.group(1)).strip(" ,.")
    return value or None


def _fallback_items(lines: list[str]) -> list[dict]:
    rows: list[dict] = []
    seen_keys: set[str] = set()
    pattern = re.compile(
        r"^(?:(?P<index>\d{1,2})\s+)?(?P<name>[A-Za-zА-Яа-яЁё0-9 _()./+%-]{2,40})\s*:\s*(?P<value>.+)$"
    )

    for line in lines:
        match = pattern.match(line.strip())
        if not match:
            continue
        name = str(match.group("name") or "").strip(" .-")
        value = str(match.group("value") or "").strip(" .-")
        if not name or not value:
            continue
        if len(value) < 2:
            continue
        if any(skip in name.lower() for skip in ("заказ", "исполнитель", "заказчик", "наименование", "стоимость", "итог")):
            continue

        uniq_key = f"{name.casefold()}::{value.casefold()}"
        if uniq_key in seen_keys:
            continue
        seen_keys.add(uniq_key)

        item_index = int(match.group("index") or (len(rows) + 1))
        rows.append(
            {
                "item_index": item_index,
                "component_name": name,
                "component_value": value,
                "confidence": 0.65,
                "status": "unconfirmed",
            }
        )
    return sorted(rows, key=lambda item: int(item.get("item_index") or 0))


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
        first = normalized.find("{")
        last = normalized.rfind("}")
        if first != -1 and last != -1 and last > first:
            try:
                return json.loads(normalized[first : last + 1])
            except json.JSONDecodeError:
                return None
    return None


def _normalize_ai_items(items: list[dict] | None) -> list[dict]:
    normalized: list[dict] = []
    for index, row in enumerate(items or [], start=1):
        name = str(row.get("component_name") or row.get("name") or "").strip()
        value = str(row.get("component_value") or row.get("value") or "").strip()
        if not name or not value:
            continue
        try:
            confidence = float(row.get("confidence") or 0.65)
        except Exception:
            confidence = 0.65
        normalized.append(
            {
                "item_index": int(row.get("item_index") or index),
                "component_name": name,
                "component_value": value,
                "confidence": max(0.0, min(confidence, 1.0)),
                "status": "unconfirmed" if confidence < 0.8 else "parsed",
            }
        )
    return sorted(normalized, key=lambda item: int(item.get("item_index") or 0))


async def _extract_with_ai(text: str) -> dict | None:
    if not config.GEMINI_API_KEY:
        return None

    prompt = (
        "Извлеки из текста технической спецификации JSON без пояснений.\n"
        "Формат: {\"customer_total\": number|null, \"customer_name\": string|null, \"order_phone\": string|null, "
        "\"items\": [{\"item_index\": number, \"component_name\": string, \"component_value\": string, \"confidence\": number}]}\n"
        "confidence от 0 до 1.\n"
        "Если данных нет, ставь null или пустой массив.\n\n"
        f"Текст:\n{text[:18000]}"
    )

    try:
        kwargs = {"api_key": config.GEMINI_API_KEY}
        if config.AI_BASE_URL:
            kwargs["base_url"] = config.AI_BASE_URL
        client = AsyncOpenAI(**kwargs)
        response = await client.chat.completions.create(
            model=get_active_ai_model(),
            messages=[
                {"role": "system", "content": "Ты извлекаешь структурированные данные из технической спецификации."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.1,
            timeout=25,
        )
        content = (response.choices[0].message.content or "").strip()
        payload = _extract_json_payload(content)
        if not payload:
            return None
        items = _normalize_ai_items(payload.get("items"))
        customer_total = _parse_amount(str(payload.get("customer_total") or ""))
        customer_name = str(payload.get("customer_name") or "").strip() or None
        order_phone = str(payload.get("order_phone") or "").strip() or None
        return {
            "items": items,
            "customer_total": customer_total,
            "customer_name": customer_name,
            "order_phone": order_phone,
            "_mode": "ai",
        }
    except Exception:
        logger.warning("AI spec parsing failed, fallback mode enabled", exc_info=True)
        return None


async def parse_spec_file(path: Path) -> dict:
    """Parses technical specification file and returns normalized payload."""
    extension = path.suffix.lower()
    if extension == ".docx":
        text = _extract_docx_text(path)
    elif extension == ".pdf":
        text = _extract_pdf_text(path)
    else:
        raise ValueError("Unsupported specification format")

    text = str(text or "").strip()
    if not text:
        return {"items": [], "customer_total": None, "customer_name": None, "order_phone": None, "_mode": "empty"}

    ai_payload = await _extract_with_ai(text)
    if ai_payload and ai_payload.get("items"):
        ai_payload["text_excerpt"] = text[:2000]
        return ai_payload

    lines = _extract_spec_block_lines(text)
    items = _fallback_items(lines)
    return {
        "items": items,
        "customer_total": _extract_customer_total(text),
        "customer_name": _extract_customer_name(text),
        "order_phone": _extract_order_phone(text),
        "_mode": "fallback",
        "text_excerpt": text[:2000],
    }


async def parse_spec_text(text: str) -> dict:
    """Parses pasted textual specification."""
    source_text = str(text or "").strip()
    if not source_text:
        return {"items": [], "customer_total": None, "customer_name": None, "order_phone": None, "_mode": "empty"}

    ai_payload = await _extract_with_ai(source_text)
    if ai_payload and ai_payload.get("items"):
        ai_payload["text_excerpt"] = source_text[:2000]
        return ai_payload

    lines = _extract_spec_block_lines(source_text)
    items = _fallback_items(lines)
    return {
        "items": items,
        "customer_total": _extract_customer_total(source_text),
        "customer_name": _extract_customer_name(source_text),
        "order_phone": _extract_order_phone(source_text),
        "_mode": "fallback_text",
        "text_excerpt": source_text[:2000],
    }
