"""Recognition quality analytics and prompt hints."""

from __future__ import annotations

import asyncio
import json
import re
from collections import Counter
from datetime import datetime, timedelta

import config
from bot.services.database import get_recognition_logs

PROMPT_HINTS_PATH = config.DATA_DIR / "prompt_hints_latest.md"


def _parse_dt(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def _looks_like_amount_shortcut(text: str) -> bool:
    return bool(re.search(r"\b\d+\s*[кk]\b", text.lower()))


def _top_items(items: list[str], limit: int = 5) -> list[tuple[str, int]]:
    cleaned = [str(item).strip() for item in items if str(item).strip()]
    return Counter(cleaned).most_common(limit)


def _extract_corrected_fields(corrections: list[str]) -> list[tuple[str, int]]:
    fields = []
    for text in corrections:
        match = re.search(r"исправь\s+([^\s]+)", str(text).lower())
        if match:
            fields.append(match.group(1))
    return _top_items(fields, limit=5)


def _generate_hint_lines(failed_texts: list[str], corrections: list[str]) -> list[str]:
    hints: list[str] = []
    lowered_failed = [text.lower() for text in failed_texts]

    if any(_looks_like_amount_shortcut(text) for text in failed_texts):
        hints.append("Усилить правило для сумм с сокращением `к`/`k` (пример: `35к`).")
    if any("сбп" in text for text in lowered_failed):
        hints.append("Добавить явный приоритет: `СБП` -> способ оплаты `перевод`.")
    if any("вб" in text or "wb" in text for text in lowered_failed):
        hints.append("Усилить нормализацию синонимов счетов `WB/ВБ` и ФИО владельцев.")
    if any("доплат" in text or "остаток" in text for text in lowered_failed):
        hints.append("Усилить классификацию `доплатил/остаток` как `постоплата`.")
    if any("заказ" in text and re.search(r"\+?7|8\d{10}", text) for text in failed_texts):
        hints.append("Добавить intent-обработку сообщений `Заказ +телефон ФИО` без команды.")

    corrected_fields = _extract_corrected_fields(corrections)
    if corrected_fields:
        hints.append(
            "Чаще всего вручную исправляют поля: "
            + ", ".join(f"`{field}` ({count})" for field, count in corrected_fields)
            + "."
        )

    if not hints:
        hints.append("Критичных паттернов ошибок не обнаружено; продолжать сбор журнала.")
    return hints


def _write_hints_file(lines: list[str], examples: list[str], days: int):
    header = [
        f"# Prompt Hints ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')})",
        f"Период анализа: {days} дней",
        "",
        "## Рекомендации",
    ]
    body = [f"- {line}" for line in lines]
    tail = ["", "## Примеры нераспознанных сообщений"]
    if examples:
        tail.extend([f"- {example}" for example in examples[:10]])
    else:
        tail.append("- Нет примеров за выбранный период.")

    content = "\n".join([*header, *body, *tail]).strip() + "\n"
    PROMPT_HINTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PROMPT_HINTS_PATH.write_text(content, encoding="utf-8")


async def build_quality_report(days: int = 7, limit: int = 500) -> str:
    """Builds quality report and writes prompt hints file."""
    days = max(1, min(days, 60))
    limit = max(50, min(limit, 2000))

    logs = await get_recognition_logs(limit=limit)
    threshold = datetime.now() - timedelta(days=days)
    filtered = []
    for item in logs:
        created_at = _parse_dt(str(item.get("created_at") or ""))
        if created_at and created_at >= threshold:
            filtered.append(item)

    if not filtered:
        _write_hints_file(
            lines=["Нет данных для анализа, продолжайте использовать бота."],
            examples=[],
            days=days,
        )
        return (
            f"Качество распознавания за {days} дн.: данных пока нет.\n"
            f"Файл подсказок: {PROMPT_HINTS_PATH}"
        )

    status_counter = Counter(str(item.get("status") or "unknown") for item in filtered)
    failed = [item for item in filtered if item.get("status") == "parse_failed"]
    clarified = [item for item in filtered if item.get("status") == "clarified"]
    saved = [item for item in filtered if item.get("status") == "saved"]

    failed_texts = [str(item.get("source_text") or "").strip() for item in failed]
    correction_texts = [str(item.get("correction_text") or "").strip() for item in clarified]
    hint_lines = _generate_hint_lines(failed_texts, correction_texts)
    _write_hints_file(hint_lines, failed_texts, days=days)

    top_failed = _top_items(failed_texts, limit=5)
    success_base = len(saved) + len(failed)
    success_rate = (len(saved) / success_base * 100.0) if success_base else 100.0

    lines = [
        f"Качество распознавания за {days} дн.",
        "",
        f"Всего событий: {len(filtered)}",
        f"Сохранено: {len(saved)}",
        f"С ручными уточнениями: {len(clarified)}",
        f"Не распознано: {len(failed)}",
        f"Быстрый KPI (saved/(saved+failed)): {success_rate:.1f}%",
        "",
        "Статусы:",
    ]
    lines.extend([f"- {status}: {count}" for status, count in status_counter.most_common()])
    lines.append("")
    lines.append("Частые нераспознанные формулировки:")
    if top_failed:
        lines.extend([f"- {text} ({count})" for text, count in top_failed])
    else:
        lines.append("- Нет.")

    lines.append("")
    lines.append("Автоподсказки для промпта:")
    lines.extend([f"- {item}" for item in hint_lines])
    lines.append("")
    lines.append(f"Файл подсказок: {PROMPT_HINTS_PATH}")
    return "\n".join(lines)
