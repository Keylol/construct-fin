import pytest

from bot.handlers import reports


class DummyMessage:
    def __init__(self):
        self.replies = []

    async def reply_text(self, text, **kwargs):
        self.replies.append(text)


class DummyUpdate:
    def __init__(self):
        self.message = DummyMessage()


class DummyContext:
    def __init__(self, args):
        self.args = args


@pytest.mark.asyncio
async def test_report_default_args(monkeypatch):
    calls = []

    async def fake_build_report(report_type, start_date, end_date):
        calls.append((report_type, start_date, end_date))
        return "OK_REPORT"

    monkeypatch.setattr(reports, "build_report", fake_build_report)

    update = DummyUpdate()
    context = DummyContext(args=[])
    await reports.handle_report_command(update, context)

    assert calls
    assert calls[0][0] == "profit"
    assert "OK_REPORT" in update.message.replies[-1]


@pytest.mark.asyncio
async def test_report_custom_range(monkeypatch):
    calls = []

    async def fake_build_report(report_type, start_date, end_date):
        calls.append((report_type, start_date, end_date))
        return "RANGE_REPORT"

    monkeypatch.setattr(reports, "build_report", fake_build_report)

    update = DummyUpdate()
    context = DummyContext(args=["sales", "2026-03-01", "2026-03-28"])
    await reports.handle_report_command(update, context)

    assert calls == [("sales", "2026-03-01", "2026-03-28")]
    assert "RANGE_REPORT" in update.message.replies[-1]


@pytest.mark.asyncio
async def test_report_invalid_type(monkeypatch):
    async def fake_build_report(report_type, start_date, end_date):
        raise AssertionError("build_report should not be called for invalid type")

    monkeypatch.setattr(reports, "build_report", fake_build_report)

    update = DummyUpdate()
    context = DummyContext(args=["unknown_type"])
    await reports.handle_report_command(update, context)

    assert "неизвестный тип отчета" in update.message.replies[-1].lower()


@pytest.mark.asyncio
async def test_report_russian_alias(monkeypatch):
    calls = []

    async def fake_build_report(report_type, start_date, end_date):
        calls.append((report_type, start_date, end_date))
        return "ALIAS_REPORT"

    monkeypatch.setattr(reports, "build_report", fake_build_report)

    update = DummyUpdate()
    context = DummyContext(args=["прибыль", "week"])
    await reports.handle_report_command(update, context)

    assert calls
    assert calls[0][0] == "profit"
    assert "ALIAS_REPORT" in update.message.replies[-1]


@pytest.mark.asyncio
async def test_report_nonop_alias(monkeypatch):
    calls = []

    async def fake_build_report(report_type, start_date, end_date):
        calls.append((report_type, start_date, end_date))
        return "NONOP_REPORT"

    monkeypatch.setattr(reports, "build_report", fake_build_report)

    update = DummyUpdate()
    context = DummyContext(args=["внереализационные", "month"])
    await reports.handle_report_command(update, context)

    assert calls
    assert calls[0][0] == "nonop_expenses"
    assert "NONOP_REPORT" in update.message.replies[-1]
