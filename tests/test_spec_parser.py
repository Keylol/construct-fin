import zipfile
from pathlib import Path
from uuid import uuid4

import pytest

import config
from bot.services import spec_parser


def _build_docx(path, lines):
    paragraphs = "".join(
        f"<w:p><w:r><w:t>{line}</w:t></w:r></w:p>"
        for line in lines
    )
    xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{paragraphs}</w:body></w:document>"
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<?xml version='1.0'?>")
        archive.writestr("word/document.xml", xml)


def test_spec_caption_detection_and_mode():
    assert spec_parser.is_spec_caption("спецификация заказ")
    assert spec_parser.is_spec_caption("заказ")
    assert not spec_parser.is_spec_caption("просто документ")
    assert spec_parser.detect_spec_mode("спецификация заказ замени") == "replace"
    assert spec_parser.detect_spec_mode("спецификация заказ новая версия") == "new_version"


@pytest.mark.asyncio
async def test_parse_spec_docx_fallback(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "")
    artifacts_dir = Path("data") / "test_artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    docx_path = artifacts_dir / f"spec_{uuid4().hex}.docx"
    _build_docx(
        docx_path,
        [
            "Детали заказа:",
            "Заказ №: 89001234567 от 2026-04-05",
            "Заказчик: Иванов Иван",
            "Техническая спецификация:",
            "1 Процессор: Intel Core i5-13400F",
            "2 Видеокарта: RTX 4060",
            "Итоговая стоимость: 100 000",
            "Гарантийные условия:",
        ],
    )

    try:
        parsed = await spec_parser.parse_spec_file(docx_path)

        assert parsed["items"]
        assert len(parsed["items"]) == 2
        assert parsed["items"][0]["component_name"] == "Процессор"
        assert parsed["customer_total"] == 100000.0
        assert parsed["order_phone"] == "+79001234567"
    finally:
        docx_path.unlink(missing_ok=True)
