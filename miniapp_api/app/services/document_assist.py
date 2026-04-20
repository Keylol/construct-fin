"""Document helper suggestions for Mini App order workflows."""

from __future__ import annotations

from pathlib import Path

from bot.services.spec_parser import parse_spec_file
from miniapp_api.app.models import MiniDocument, MiniOrder


def _average_confidence(items: list[dict]) -> float | None:
    confidences = []
    for item in items:
        try:
            confidences.append(float(item.get("confidence") or 0.0))
        except Exception:  # noqa: BLE001
            continue
    if not confidences:
        return None
    return round(sum(confidences) / len(confidences), 2)


def _spec_like(document: MiniDocument) -> bool:
    doc_type = str(document.doc_type or "").strip().lower()
    file_name = str(document.file_name or "").strip().lower()
    return any(marker in doc_type for marker in ("специ", "spec")) or any(marker in file_name for marker in ("специ", "spec"))


def _generic_receipt_response(finance: dict[str, float]) -> dict:
    actions = []
    if float(finance.get("purchase_cost") or 0.0) <= 0.0:
        actions.append("Добавьте закупку к заказу")
    else:
        actions.append("Сверьте сумму закупки с файлом")
    if float(finance.get("sale_amount") or 0.0) <= 0.0:
        actions.append("Проверьте цену продажи")
    if float(finance.get("balance_due") or 0.0) > 0.01:
        actions.append("После сверки проверьте доплату по заказу")
    return {
        "mode": "receipt",
        "title": "Похоже на чек закупки",
        "summary": "Файл сохранен как подтверждение закупки по заказу.",
        "highlights": [],
        "suggested_actions": actions or ["Оставьте файл в заказе как подтверждение"],
        "items_preview": [],
        "parsed_items": [],
        "customer_total": None,
        "customer_name": None,
        "order_phone": None,
        "confidence": None,
    }


def _generic_warranty_response(finance: dict[str, float]) -> dict:
    actions = ["Проверьте модель и серийный номер вручную", "Оставьте файл в заказе как гарантийный документ"]
    if float(finance.get("sale_amount") or 0.0) <= 0.0:
        actions.insert(0, "Проверьте цену продажи")
    return {
        "mode": "warranty",
        "title": "Похоже на гарантийный документ",
        "summary": "Файл сохранен в заказе и пригоден как гарантийное подтверждение.",
        "highlights": [],
        "suggested_actions": actions,
        "items_preview": [],
        "parsed_items": [],
        "customer_total": None,
        "customer_name": None,
        "order_phone": None,
        "confidence": None,
    }


def _generic_document_response() -> dict:
    return {
        "mode": "general",
        "title": "Файл сохранен в заказе",
        "summary": "Помощник не увидел явной спецификации, но файл доступен внутри заказа.",
        "highlights": [],
        "suggested_actions": ["Проверьте содержимое файла вручную", "Оставьте файл в заказе как подтверждение"],
        "items_preview": [],
        "parsed_items": [],
        "customer_total": None,
        "customer_name": None,
        "order_phone": None,
        "confidence": None,
    }


async def build_document_assist_payload(
    *,
    document: MiniDocument,
    order: MiniOrder,
    finance: dict[str, float],
) -> dict:
    """Builds compact helper payload for a single order document."""

    file_path = Path(str(document.file_path or "")).resolve()
    extension = file_path.suffix.lower()
    doc_type = str(document.doc_type or "").strip().lower()

    if _spec_like(document) and extension in {".pdf", ".docx"} and file_path.exists():
        parsed = await parse_spec_file(file_path)
        items = list(parsed.get("items") or [])
        item_lines = [f"{item.get('component_name')}: {item.get('component_value')}" for item in items[:5]]
        highlights: list[str] = []
        actions = ["Проверьте комплектующие и перенесите их в заказ"]

        customer_total = parsed.get("customer_total")
        customer_name = parsed.get("customer_name")
        parsed_order_phone = parsed.get("order_phone")
        confidence = _average_confidence(items)

        if customer_total:
            highlights.append(f"Найдена сумма продажи: {int(float(customer_total)):,} ₽".replace(",", " "))
            if float(finance.get("sale_amount") or 0.0) <= 0.0:
                actions.append("Проверьте и внесите цену продажи из спецификации")
            elif abs(float(finance.get("sale_amount") or 0.0) - float(customer_total)) > 0.01:
                actions.append("Сверьте сумму продажи со спецификацией")
        else:
            actions.append("Проверьте итоговую цену продажи вручную")

        if customer_name:
            highlights.append(f"Клиент в документе: {customer_name}")
        if parsed_order_phone:
            if str(parsed_order_phone).strip() == str(order.order_phone or "").strip():
                highlights.append(f"Телефон в документе совпадает: {parsed_order_phone}")
            else:
                highlights.append(f"Телефон в документе отличается: {parsed_order_phone}")
                actions.append("Сверьте телефон в документе с текущим заказом")

        if float(finance.get("purchase_cost") or 0.0) <= 0.0:
            actions.append("После проверки добавьте закупки по комплектующим")
        if float(finance.get("balance_due") or 0.0) > 0.01:
            actions.append("После заполнения проверьте остаток к доплате")

        if items:
            summary = f"Нашел {len(items)} позиций в спецификации."
        else:
            summary = "Спецификация распознана частично, комплектующие лучше проверить вручную."
            actions.insert(0, "Проверьте комплектующие вручную")

        return {
            "mode": "spec",
            "title": "Предложение по спецификации",
            "summary": summary,
            "highlights": highlights,
            "suggested_actions": actions[:5],
            "items_preview": item_lines,
            "parsed_items": [
                {
                    "component_name": str(item.get("component_name") or "").strip(),
                    "component_value": str(item.get("component_value") or "").strip(),
                    "confidence": float(item.get("confidence") or 0.0) if item.get("confidence") is not None else None,
                }
                for item in items
                if str(item.get("component_name") or "").strip() and str(item.get("component_value") or "").strip()
            ],
            "customer_total": float(customer_total) if customer_total else None,
            "customer_name": customer_name,
            "order_phone": parsed_order_phone,
            "confidence": confidence,
        }

    if doc_type == "чек" or extension == ".pdf":
        return _generic_receipt_response(finance)
    if doc_type == "гарантия":
        return _generic_warranty_response(finance)
    return _generic_document_response()
