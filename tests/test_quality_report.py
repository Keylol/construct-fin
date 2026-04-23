from pathlib import Path
from uuid import uuid4

import pytest

from bot.services import quality_report
from bot.services.quality_journal import append_quality_journal_entry


@pytest.mark.asyncio
async def test_quality_report_builds_and_writes_hints(monkeypatch):
    artifacts_dir = Path("data") / "test_artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    hint_path = artifacts_dir / f"hints_{uuid4().hex}.md"
    monkeypatch.setattr(quality_report, "PROMPT_HINTS_PATH", hint_path)

    fake_logs = [
        {
            "source_text": "Заказ +79991234567 Иванов Иван",
            "status": "parse_failed",
            "parser_mode": "none",
            "created_by": "1:tester",
            "created_at": "2026-04-04 12:00:00",
            "correction_text": None,
        },
        {
            "source_text": "клиент доплатил 35к наличкой",
            "status": "clarified",
            "parser_mode": "ai",
            "created_by": "1:tester",
            "created_at": "2026-04-04 12:10:00",
            "correction_text": "исправь сумму 35000",
        },
        {
            "source_text": "продажа сборки 120000",
            "status": "saved",
            "parser_mode": "ai",
            "created_by": "1:tester",
            "created_at": "2026-04-04 12:15:00",
            "correction_text": None,
        },
    ]

    async def fake_get_logs(limit):
        return fake_logs

    monkeypatch.setattr(quality_report, "get_recognition_logs", fake_get_logs)

    report = await quality_report.build_quality_report(days=30, limit=100)

    assert "Качество распознавания" in report
    assert "Не распознано: 1" in report
    assert "Автоподсказки для промпта" in report
    assert hint_path.exists()
    content = hint_path.read_text(encoding="utf-8")
    assert "Рекомендации" in content
    hint_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_quality_journal_appends_line(monkeypatch):
    artifacts_dir = Path("data") / "test_artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    journal_path = artifacts_dir / f"recognition_quality_{uuid4().hex}.ndjson"
    from bot.services import quality_journal

    monkeypatch.setattr(quality_journal, "QUALITY_JOURNAL_PATH", journal_path)

    await append_quality_journal_entry(
        source_text="продажа 100000",
        created_by="1:tester",
        status="saved",
        parser_mode="ai",
    )

    assert journal_path.exists()
    text = journal_path.read_text(encoding="utf-8")
    assert "продажа 100000" in text
    journal_path.unlink(missing_ok=True)
