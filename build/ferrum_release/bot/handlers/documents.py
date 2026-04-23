"""Document handler: saves files and launches specification flow when applicable."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path

from telegram import Update
from telegram.ext import ContextTypes

import config
from bot.handlers.messages import ACTIVE_ORDER_ID_KEY, _start_spec_session
from bot.services.database import (
    add_document,
    add_spec_document,
    add_spec_items,
    find_document_by_hash,
    get_latest_spec_document_for_order,
    get_primary_spec_document_for_order,
    get_order_by_id,
)
from bot.services.sheets import setup_management_spreadsheet
from bot.services.spec_parser import is_spec_caption, parse_spec_file

logger = logging.getLogger(__name__)


async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handles uploaded PDF/DOC/DOCX and binds them to active order."""
    document = update.message.document
    if not document:
        await update.message.reply_text("Прикрепите файл PDF/DOC/DOCX документом.")
        return

    extension = Path(document.file_name or "").suffix.lower()
    if extension not in config.SUPPORTED_DOCUMENT_EXTENSIONS:
        await update.message.reply_text("Поддерживаются только PDF, DOC и DOCX.")
        return

    active_order_id = context.user_data.get(ACTIVE_ORDER_ID_KEY)
    if not active_order_id:
        await update.message.reply_text("Сначала откройте заказ: /order +79991234567")
        return

    order = await get_order_by_id(int(active_order_id))
    if not order or order.get("status") != "open":
        context.user_data.pop(ACTIVE_ORDER_ID_KEY, None)
        await update.message.reply_text("Активный заказ не найден. Откройте заново: /order +79991234567")
        return

    file_size_kb = round((document.file_size or 0) / 1024, 1)
    file_name = Path(document.file_name or "document").name
    await update.message.reply_text(f"Получил файл: {file_name} ({file_size_kb} KB). Сохраняю...")

    try:
        docs_dir = config.DOCUMENTS_DIR / str(order["order_phone"]) / f"order_{order['id']}"
        docs_dir.mkdir(parents=True, exist_ok=True)

        tg_file = await context.bot.get_file(document.file_id)
        file_path = _unique_path(docs_dir / file_name)
        await tg_file.download_to_drive(str(file_path))
        file_hash = _file_sha256(file_path)

        duplicate = await find_document_by_hash(
            client_id=int(order["client_id"]),
            order_id=int(order["id"]),
            file_hash=file_hash,
        )
        if duplicate:
            file_path.unlink(missing_ok=True)
            await update.message.reply_text(f"Файл уже был загружен ранее: {duplicate['file_name']}")
            return

        caption = (update.message.caption or "").strip()
        explicit_spec = is_spec_caption(caption)
        doc_type = "спецификация" if explicit_spec else _detect_doc_type(caption, extension)
        user = update.effective_user
        uploaded_by = f"{user.id}:{user.first_name}"

        doc_id = await add_document(
            client_id=int(order["client_id"]),
            order_id=int(order["id"]),
            doc_type=doc_type,
            file_name=file_path.name,
            file_path=str(file_path),
            uploaded_by=uploaded_by,
            file_hash=file_hash,
        )
        await update.message.reply_text(
            f"Документ сохранен (#{doc_id}).\n"
            f"Заказ: {order['order_phone']}\n"
            f"Файл: {file_path.name}"
        )

        caption_lower = caption.lower()
        should_try_spec = extension in {".docx", ".pdf"} and (
            explicit_spec
            or "заказ" in caption_lower
            or "специф" in caption_lower
        )
        if not should_try_spec:
            return

        await update.message.reply_text("Разбираю техническую спецификацию...")
        parsed = await parse_spec_file(file_path)
        items = list(parsed.get("items") or [])
        customer_total = float(parsed.get("customer_total") or 0.0) or None
        parse_mode = str(parsed.get("_mode") or "").strip().lower()

        if not _is_likely_spec_payload(items=items, customer_total=customer_total, explicit_spec=explicit_spec):
            if extension == ".pdf" and parse_mode == "empty":
                await update.message.reply_text(
                    "Не смог извлечь текст из PDF (похоже, это скан).\n"
                    "Вставьте текст спецификации сообщением в чат (блок `Техническая спецификация`)."
                )
                return
            if explicit_spec:
                await update.message.reply_text(
                    "Не смог извлечь список комплектующих из файла. "
                    "Проверьте документ или вставьте текст спецификации сообщением."
                )
            return

        latest = await get_latest_spec_document_for_order(int(order["id"]))
        primary_spec = await get_primary_spec_document_for_order(int(order["id"]))
        version = int(latest["version"]) + 1 if latest else 1
        has_working_primary = bool(primary_spec and str(primary_spec.get("parse_status") or "").lower() == "parsed")
        is_primary_spec = not has_working_primary
        created_by = f"{user.id}:{user.first_name}"
        spec_id = await add_spec_document(
            order_id=int(order["id"]),
            client_id=int(order["client_id"]),
            document_id=doc_id,
            version=version,
            parse_mode="primary" if is_primary_spec else "manual_review",
            parse_status=("parsed" if is_primary_spec else "manual_review") if items else "parse_failed",
            source_file_name=file_path.name,
            source_file_path=str(file_path),
            extracted_payload=json.dumps(parsed, ensure_ascii=False),
            customer_total=customer_total,
            created_by=created_by,
        )
        if not items:
            await update.message.reply_text("Спецификация распознана, но без позиций. Проверьте документ.")
            return

        await add_spec_items(spec_id, items)
        await update.message.reply_text(
            _spec_summary_text(
                spec_id=spec_id,
                version=version,
                items=items,
                customer_total=customer_total,
            )
        )
        if is_primary_spec:
            await _start_spec_session(
                update,
                context,
                order=order,
                spec_document_id=spec_id,
                customer_total=customer_total,
                source_name=file_path.name,
            )
        else:
            await update.message.reply_text(
                "Это повторная спецификация. Добавил в ручную проверку — "
                "она не влияет на финансы автоматически."
            )

        try:
            await setup_management_spreadsheet()
        except Exception:
            logger.warning("Could not sync sheets after spec upload", exc_info=True)
    except Exception as exc:
        logger.error("Ошибка загрузки документа: %s", exc, exc_info=True)
        await update.message.reply_text(f"Ошибка при сохранении файла: {exc}")


def _unique_path(path: Path) -> Path:
    candidate = path
    counter = 1
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}_{counter}{path.suffix}")
        counter += 1
    return candidate


def _file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(8192), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _detect_doc_type(caption: str, extension: str) -> str:
    caption_lower = (caption or "").lower()
    if "чек" in caption_lower:
        return "чек"
    if "гарант" in caption_lower:
        return "гарантия"
    if "специф" in caption_lower:
        return "спецификация"
    if extension == ".pdf":
        return "чек"
    return "другое"


def _is_likely_spec_payload(*, items: list[dict], customer_total: float | None, explicit_spec: bool) -> bool:
    if explicit_spec and items:
        return True
    if len(items) >= 2:
        return True
    if customer_total and items:
        return True
    return False


def _spec_summary_text(spec_id: int, version: int, items: list[dict], customer_total: float | None) -> str:
    lines = [
        f"Спецификация сохранена (#{spec_id}, версия {version}).",
        f"Найдено позиций: {len(items)}",
    ]
    if customer_total:
        lines.append(f"Итог для клиента: {customer_total:,.0f} ₽")
    preview = items[:8]
    if preview:
        lines.append("")
        lines.append("Первые позиции:")
        for item in preview:
            lines.append(
                f"{int(item.get('item_index') or 0)}. "
                f"{item.get('component_name')}: {item.get('component_value')}"
            )
    if len(items) > len(preview):
        lines.append(f"... и еще {len(items) - len(preview)}")
    return "\n".join(lines)
