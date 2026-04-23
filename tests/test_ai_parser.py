import json

import pytest

import config
from bot.services import ai_parser


class _DummyMessage:
    def __init__(self, content: str):
        self.content = content


class _DummyChoice:
    def __init__(self, content: str):
        self.message = _DummyMessage(content)


class _DummyResponse:
    def __init__(self, content: str):
        self.choices = [_DummyChoice(content)]


class _CompletionsOK:
    def __init__(self, payload: dict):
        self._payload = payload

    async def create(self, *args, **kwargs):
        return _DummyResponse(json.dumps(self._payload, ensure_ascii=False))


class _CompletionsBroken:
    @staticmethod
    async def create(*args, **kwargs):
        raise RuntimeError("ai unavailable")


class _ClientOK:
    def __init__(self, payload: dict):
        class _Chat:
            def __init__(self, payload: dict):
                self.completions = _CompletionsOK(payload)

        self.chat = _Chat(payload)


class _ClientBroken:
    def __init__(self, **kwargs):
        class _Chat:
            completions = _CompletionsBroken()

        self.chat = _Chat()


@pytest.mark.asyncio
async def test_parse_operation_returns_none_without_ai_key(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "")
    parsed = await ai_parser.parse_operation("купил SSD за 5000")
    assert parsed is None


@pytest.mark.asyncio
async def test_parse_operation_returns_none_on_ai_error(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "fake-key")
    monkeypatch.setattr(ai_parser, "AsyncOpenAI", _ClientBroken)
    parsed = await ai_parser.parse_operation("продажа ноутбука 100000")
    assert parsed is None


@pytest.mark.asyncio
async def test_parse_operation_normalizes_ai_payload(monkeypatch):
    payload = {
        "operation_type": "расход",
        "description": "купили воду в офис за 840",
        "amount": 840,
        "expense_category": None,
        "payment_account": "ИП Каменский АБ",
        "payment_source": "корп",
        "payment_method": "карта",
        "business_direction": "Розница",
        "confidence": 0.4,
    }

    monkeypatch.setattr(config, "GEMINI_API_KEY", "fake-key")
    monkeypatch.setattr(ai_parser, "AsyncOpenAI", lambda **kwargs: _ClientOK(payload))

    parsed = await ai_parser.parse_operation("купили воду в офис за 840")

    assert parsed is not None
    assert parsed["operation_type"] == "расход"
    assert parsed["expense_category"] == "Офис"
    assert parsed["_confidence"] >= 0.9
    assert parsed["_parser_mode"] == "ai"


@pytest.mark.asyncio
async def test_parse_user_intent_without_ai_key_returns_other(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "")
    payload = await ai_parser.parse_user_intent("заказ +79991234567 Иванов")
    assert payload["intent"] == "other"
    assert payload["_parser_mode"] == "none"


@pytest.mark.asyncio
async def test_parse_user_intent_ai_payload_is_normalized(monkeypatch):
    payload = {
        "intent": "open_order",
        "phone": "8 (999) 123-45-67",
        "full_name": "Иванов Иван",
        "operation_id": None,
        "delete_last": False,
        "confidence": 0.91,
    }
    monkeypatch.setattr(config, "GEMINI_API_KEY", "fake-key")
    monkeypatch.setattr(ai_parser, "AsyncOpenAI", lambda **kwargs: _ClientOK(payload))

    parsed = await ai_parser.parse_user_intent("создай заказ +79991234567 Иванов Иван")

    assert parsed["intent"] == "open_order"
    assert parsed["phone"] == "+79991234567"
    assert parsed["confidence"] >= 0.9
    assert parsed["_parser_mode"] == "ai"


@pytest.mark.asyncio
async def test_parse_user_intent_ai_error_returns_other(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "fake-key")
    monkeypatch.setattr(ai_parser, "AsyncOpenAI", _ClientBroken)

    parsed = await ai_parser.parse_user_intent("удали последнюю")

    assert parsed["intent"] == "other"
    assert parsed["_parser_mode"] == "ai_failed"


@pytest.mark.asyncio
async def test_parse_operations_splits_two_chunks(monkeypatch):
    async def fake_parse_operation(chunk: str):
        if "12000" in chunk:
            return {"operation_type": "закупка", "amount": 12000}
        if "840" in chunk:
            return {"operation_type": "расход", "amount": 840}
        return None

    monkeypatch.setattr(ai_parser, "parse_operation", fake_parse_operation)
    parsed = await ai_parser.parse_operations("купили ssd за 12000 и воду в офис за 840")

    assert len(parsed) == 2
    assert parsed[0]["amount"] == 12000
    assert parsed[1]["operation_type"] == "расход"
