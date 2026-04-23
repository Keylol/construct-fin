import pytest

from bot.handlers import messages


class DummySentMessage:
    def __init__(self):
        self.edits = []

    async def edit_text(self, text, **kwargs):
        self.edits.append(text)


class DummyIncomingMessage:
    def __init__(self, text):
        self.text = text
        self.reply_calls = []
        self.sent_messages = []

    async def reply_text(self, text, **kwargs):
        self.reply_calls.append(text)
        sent = DummySentMessage()
        self.sent_messages.append(sent)
        return sent


class DummyUser:
    def __init__(self):
        self.id = 42
        self.first_name = "Tester"
        self.username = "tester"


class DummyUpdate:
    def __init__(self, text):
        self.message = DummyIncomingMessage(text)
        self.effective_user = DummyUser()


class DummyContext:
    def __init__(self):
        self.user_data = {}


@pytest.mark.asyncio
async def test_soft_confirmation_then_save(monkeypatch):
    logs = []
    saved_payloads = []

    async def fake_parse_operation(text):
        return {
            "operation_type": "продажа",
            "description": "Продажа ПК",
            "amount": 55000,
            "supplier": None,
            "payment_source": "физ",
            "payment_account": "Каменский ВБ",
            "payment_method": "карта",
            "business_direction": "Розница",
            "expense_category": None,
            "client_name": "Иванов",
            "client_phone": "+79991234567",
            "date": "2026-03-28",
            "comment": None,
            "income_channel": "Онлайн",
            "sale_type": "Сборка",
            "_parser_mode": "fallback",
        }

    async def fake_add_operation(**kwargs):
        saved_payloads.append(kwargs)
        return 777

    async def fake_add_log(**kwargs):
        logs.append(kwargs)
        return len(logs)

    async def fake_get_or_create_client_by_phone(**kwargs):
        return 1, True

    async def fake_get_latest_order_for_phone(phone):
        return None

    async def fake_create_order(**kwargs):
        return 13

    async def fake_append_to_sheet(operation_data, operation_id):
        return None

    async def fake_sale_block_reason(_payload):
        return None

    monkeypatch.setattr(messages.ai_parser, "parse_operation", fake_parse_operation)
    monkeypatch.setattr(messages, "add_operation", fake_add_operation)
    monkeypatch.setattr(messages, "add_recognition_log", fake_add_log)
    monkeypatch.setattr(messages, "get_or_create_client_by_phone", fake_get_or_create_client_by_phone)
    monkeypatch.setattr(messages, "get_latest_order_for_phone", fake_get_latest_order_for_phone)
    monkeypatch.setattr(messages, "create_order", fake_create_order)
    monkeypatch.setattr(messages, "append_operation_to_sheet", fake_append_to_sheet)
    monkeypatch.setattr(messages, "_sale_block_reason", fake_sale_block_reason)

    context = DummyContext()

    update_first = DummyUpdate("продажа ПК 55000 +79991234567")
    await messages.handle_text_message(update_first, context)

    sent = update_first.message.sent_messages[0]
    assert sent.edits
    assert "Ответьте `ок`" in sent.edits[-1]
    assert messages.PENDING_OPERATION_KEY in context.user_data

    update_confirm = DummyUpdate("ок, сохраняй")
    await messages.handle_text_message(update_confirm, context)
    assert messages.PENDING_OPERATION_KEY not in context.user_data
    assert saved_payloads
    assert saved_payloads[0]["amount"] == 55000.0
    assert saved_payloads[0]["order_id"] == 13
    assert saved_payloads[0]["order_phone"] == "+79991234567"

    statuses = [entry["status"] for entry in logs]
    assert "parsed_pending" in statuses
    assert "saved" in statuses


@pytest.mark.asyncio
async def test_sale_without_spec_is_blocked(monkeypatch):
    async def fake_parse_operation(_text):
        return {
            "operation_type": "продажа",
            "description": "Продажа сборки",
            "amount": 120000,
            "payment_source": "физ",
            "payment_account": "Каменский ВБ",
            "payment_method": "карта",
            "business_direction": "Розница",
            "client_phone": "+79991234567",
            "date": "2026-03-28",
            "income_channel": "Онлайн",
            "sale_type": "Сборка",
            "_parser_mode": "fallback",
        }

    async def fake_add_log(**kwargs):
        return 1

    async def fake_get_or_create_client_by_phone(**kwargs):
        return 1, True

    async def fake_get_latest_order_for_phone(_phone):
        return None

    async def fake_create_order(**kwargs):
        return 13

    async def fake_sale_block_reason(_payload):
        return "Продажу по заказу нельзя сохранить без технической спецификации."

    monkeypatch.setattr(messages.ai_parser, "parse_operation", fake_parse_operation)
    monkeypatch.setattr(messages, "add_recognition_log", fake_add_log)
    monkeypatch.setattr(messages, "get_or_create_client_by_phone", fake_get_or_create_client_by_phone)
    monkeypatch.setattr(messages, "get_latest_order_for_phone", fake_get_latest_order_for_phone)
    monkeypatch.setattr(messages, "create_order", fake_create_order)
    monkeypatch.setattr(messages, "_sale_block_reason", fake_sale_block_reason)

    context = DummyContext()
    update = DummyUpdate("продажа сборки 120000 +79991234567")
    await messages.handle_text_message(update, context)

    sent = update.message.sent_messages[0]
    assert sent.edits
    assert "без технической спецификации" in sent.edits[-1].lower()


@pytest.mark.asyncio
async def test_pending_waits_for_order_phone(monkeypatch):
    async def fake_parse_operation(text):
        return {
            "operation_type": "закупка",
            "description": "Покупка RTX",
            "amount": 42000,
            "payment_source": "корп",
            "payment_account": "ИП Каменский АБ",
            "payment_method": "карта",
            "business_direction": "Розница",
            "date": "2026-03-28",
            "_parser_mode": "fallback",
        }

    async def fake_add_log(**kwargs):
        return 1

    async def fake_get_or_create_client_by_phone(**kwargs):
        return 2, False

    async def fake_get_latest_order_for_phone(phone):
        return None

    async def fake_create_order(**kwargs):
        return 20

    monkeypatch.setattr(messages.ai_parser, "parse_operation", fake_parse_operation)
    monkeypatch.setattr(messages, "add_recognition_log", fake_add_log)
    monkeypatch.setattr(messages, "get_or_create_client_by_phone", fake_get_or_create_client_by_phone)
    monkeypatch.setattr(messages, "get_latest_order_for_phone", fake_get_latest_order_for_phone)
    monkeypatch.setattr(messages, "create_order", fake_create_order)

    context = DummyContext()

    update_first = DummyUpdate("купил видеокарту 42000 клиенту")
    await messages.handle_text_message(update_first, context)
    assert context.user_data[messages.PENDING_WAITING_ORDER_PHONE_KEY] is True
    assert "Укажите телефон заказа" in update_first.message.sent_messages[0].edits[-1]

    update_phone = DummyUpdate("+79990001122")
    await messages.handle_text_message(update_phone, context)
    assert context.user_data[messages.PENDING_WAITING_ORDER_PHONE_KEY] is False
    assert any("Ответьте `ок`" in text for text in update_phone.message.reply_calls)
