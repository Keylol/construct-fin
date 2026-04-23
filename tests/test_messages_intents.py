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
        self.id = 99
        self.first_name = "Manager"
        self.username = "manager"


class DummyUpdate:
    def __init__(self, text):
        self.message = DummyIncomingMessage(text)
        self.effective_user = DummyUser()


class DummyContext:
    def __init__(self):
        self.user_data = {}


@pytest.mark.asyncio
async def test_open_order_from_plain_text_intent_with_choice(monkeypatch):
    async def fake_parse_user_intent(_text):
        return {
            "intent": "open_order",
            "phone": "+79991234567",
            "full_name": "Иванов Иван",
            "confidence": 0.95,
            "_parser_mode": "ai",
        }

    async def fake_parse_operations(_text):
        raise AssertionError("parse_operations must not run for open_order intent")

    async def fake_get_or_create_client_by_phone(**kwargs):
        assert kwargs["phone"] == "+79991234567"
        assert kwargs["full_name"] == "Иванов Иван"
        return 10, True

    async def fake_create_order(**kwargs):
        assert kwargs["client_id"] == 10
        assert kwargs["order_phone"] == "+79991234567"
        return 21

    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages, "get_or_create_client_by_phone", fake_get_or_create_client_by_phone)
    monkeypatch.setattr(messages, "create_order", fake_create_order)

    context = DummyContext()
    update = DummyUpdate("заказ +79991234567 Иванов Иван")
    await messages.handle_text_message(update, context)

    assert messages.PENDING_ORDER_ACTION_KEY in context.user_data
    assert any("1" in text and "2" in text for text in update.message.reply_calls)

    update_choice = DummyUpdate("1")
    await messages.handle_text_message(update_choice, context)

    assert context.user_data[messages.ACTIVE_ORDER_ID_KEY] == 21
    assert context.user_data[messages.ACTIVE_CLIENT_ID_KEY] == 10
    assert context.user_data[messages.ACTIVE_ORDER_PHONE_KEY] == "+79991234567"
    assert any("#21" in text for text in update_choice.message.reply_calls)


@pytest.mark.asyncio
async def test_open_order_choice_two_sends_sale_hint(monkeypatch):
    async def fake_parse_user_intent(_text):
        return {
            "intent": "open_order",
            "phone": "+79990001122",
            "full_name": "Петров",
            "confidence": 0.95,
            "_parser_mode": "ai",
        }

    async def fake_parse_operations(_text):
        raise AssertionError("parse_operations must not run for open_order intent")

    async def fake_get_or_create_client_by_phone(**kwargs):
        return 11, True

    async def fake_create_order(**kwargs):
        return 31

    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages, "get_or_create_client_by_phone", fake_get_or_create_client_by_phone)
    monkeypatch.setattr(messages, "create_order", fake_create_order)

    context = DummyContext()
    update = DummyUpdate("заказ +79990001122 Петров")
    await messages.handle_text_message(update, context)

    update_choice = DummyUpdate("2")
    await messages.handle_text_message(update_choice, context)

    assert context.user_data[messages.ACTIVE_ORDER_ID_KEY] == 31
    assert any("спецификац" in text.lower() for text in update_choice.message.reply_calls)


@pytest.mark.asyncio
async def test_close_order_from_ai_intent(monkeypatch):
    async def fake_parse_user_intent(_text):
        return {"intent": "close_order", "confidence": 0.95, "_parser_mode": "ai"}

    async def fake_close_order(order_id, closed_by):
        assert order_id == 21
        assert closed_by.startswith("99:")
        return True

    async def fake_parse_operations(_text):
        raise AssertionError("parse_operations must not run for close_order intent")

    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages, "close_order", fake_close_order)

    context = DummyContext()
    context.user_data[messages.ACTIVE_ORDER_ID_KEY] = 21
    context.user_data[messages.ACTIVE_CLIENT_ID_KEY] = 10
    context.user_data[messages.ACTIVE_ORDER_PHONE_KEY] = "+79991234567"

    update = DummyUpdate("закрой заказ")
    await messages.handle_text_message(update, context)

    assert messages.ACTIVE_ORDER_ID_KEY not in context.user_data
    assert any("#21" in text for text in update.message.reply_calls)


@pytest.mark.asyncio
async def test_operation_text_creates_pending_preview(monkeypatch):
    async def fake_parse_user_intent(_text):
        return {"intent": "operation_input", "confidence": 0.95, "_parser_mode": "ai"}

    async def fake_parse_operations(_text):
        return [
            {
                "operation_type": "расход",
                "description": "аренда офиса",
                "amount": 50000,
                "expense_category": "Офис",
                "payment_source": "корп",
                "payment_account": "ИП Каменский АБ",
                "payment_method": "карта",
                "business_direction": "Розница",
                "date": "2026-04-04",
                "_confidence": 0.9,
                "_parser_mode": "ai",
            }
        ]

    async def fake_log_quality_event(**kwargs):
        return None

    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages, "_log_quality_event", fake_log_quality_event)

    context = DummyContext()
    update = DummyUpdate("расход аренда офиса 50000")
    await messages.handle_text_message(update, context)

    assert messages.PENDING_OPERATION_KEY in context.user_data
    sent = update.message.sent_messages[0]
    assert sent.edits
    assert "ок" in sent.edits[-1].lower()


@pytest.mark.asyncio
async def test_delete_last_while_pending_requires_confirmation(monkeypatch):
    called = {"deleted": False}

    async def fake_get_last_operation(created_by=None):
        return {"id": 123}

    async def fake_get_operation_by_id(operation_id):
        return {"id": operation_id, "date": "2026-04-04", "operation_type": "расход", "amount": 5000, "description": "тест"}

    async def fake_delete_operation(operation_id):
        called["deleted"] = True
        assert operation_id == 123
        return True

    async def fake_setup_management_spreadsheet():
        return None

    monkeypatch.setattr(messages, "get_last_operation", fake_get_last_operation)
    monkeypatch.setattr(messages, "get_operation_by_id", fake_get_operation_by_id)
    monkeypatch.setattr(messages, "delete_operation", fake_delete_operation)
    monkeypatch.setattr(messages, "setup_management_spreadsheet", fake_setup_management_spreadsheet)

    context = DummyContext()
    context.user_data[messages.PENDING_OPERATION_KEY] = {"_parser_mode": "ai"}
    context.user_data[messages.PENDING_SOURCE_TEXT_KEY] = "расход 5000"

    update_delete = DummyUpdate("удали последнюю")
    await messages.handle_text_message(update_delete, context)

    assert messages.PENDING_OPERATION_KEY not in context.user_data
    assert messages.PENDING_DELETE_KEY in context.user_data
    assert called["deleted"] is False

    update_confirm = DummyUpdate("подтверждаю удаление")
    await messages.handle_text_message(update_confirm, context)

    assert called["deleted"] is True
    assert messages.PENDING_DELETE_KEY not in context.user_data


@pytest.mark.asyncio
async def test_delete_confirmation_can_be_canceled(monkeypatch):
    async def fake_get_operation_by_id(operation_id):
        return {"id": operation_id, "date": "2026-04-04", "operation_type": "расход", "amount": 5000, "description": "тест"}

    monkeypatch.setattr(messages, "get_operation_by_id", fake_get_operation_by_id)

    context = DummyContext()
    context.user_data[messages.PENDING_DELETE_KEY] = {"target_id": 77, "requested_by": 99}
    update = DummyUpdate("отмена")
    await messages.handle_text_message(update, context)

    assert messages.PENDING_DELETE_KEY not in context.user_data
    assert any("отмен" in text.lower() for text in update.message.reply_calls)


@pytest.mark.asyncio
async def test_low_confidence_intent_does_not_trigger_order_flow(monkeypatch):
    async def fake_parse_user_intent(_text):
        return {
            "intent": "open_order",
            "phone": "+79991234567",
            "full_name": "Иванов Иван",
            "confidence": 0.3,
            "_parser_mode": "ai",
        }

    async def fake_parse_operations(_text):
        return [
            {
                "operation_type": "расход",
                "description": "офисные расходы",
                "amount": 1200,
                "expense_category": "Офис",
                "payment_source": "корп",
                "payment_account": "ИП Каменский АБ",
                "payment_method": "карта",
                "business_direction": "Розница",
                "date": "2026-04-05",
                "_confidence": 0.95,
                "_parser_mode": "ai",
            }
        ]

    async def fake_log_quality_event(**kwargs):
        return None

    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages, "_log_quality_event", fake_log_quality_event)

    context = DummyContext()
    update = DummyUpdate("заказ +79991234567 Иванов Иван")
    await messages.handle_text_message(update, context)

    assert messages.PENDING_ORDER_ACTION_KEY not in context.user_data
    assert messages.PENDING_OPERATION_KEY in context.user_data


@pytest.mark.asyncio
async def test_ai_intent_fallback_opens_order_when_parse_failed(monkeypatch):
    async def fake_parse_operations(_text):
        return []

    async def fake_parse_user_intent(_text):
        return {
            "intent": "open_order",
            "phone": "+79990001122",
            "full_name": "Петров",
            "confidence": 0.9,
            "_parser_mode": "ai",
        }

    async def fake_get_or_create_client_by_phone(**kwargs):
        assert kwargs["phone"] == "+79990001122"
        return 11, True

    async def fake_create_order(**kwargs):
        assert kwargs["client_id"] == 11
        return 31

    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages, "get_or_create_client_by_phone", fake_get_or_create_client_by_phone)
    monkeypatch.setattr(messages, "create_order", fake_create_order)

    context = DummyContext()
    update = DummyUpdate("давай откроем карточку клиента Петров +79990001122")
    await messages.handle_text_message(update, context)

    assert context.user_data[messages.ACTIVE_ORDER_ID_KEY] == 31
    assert any("#31" in text for text in update.message.reply_calls)


@pytest.mark.asyncio
async def test_non_financial_message_returns_clear_text(monkeypatch):
    async def fake_parse_operations(_text):
        return []

    async def fake_parse_user_intent(_text):
        return {"intent": "other", "_parser_mode": "ai", "confidence": 0.9}

    async def fake_log_quality_event(**kwargs):
        return None

    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages, "_log_quality_event", fake_log_quality_event)

    context = DummyContext()
    update = DummyUpdate("как дела, позвони поставщику")
    await messages.handle_text_message(update, context)

    sent = update.message.sent_messages[0]
    assert sent.edits
    assert "не финансовая операция" in sent.edits[-1].lower()


@pytest.mark.asyncio
async def test_ambiguous_purchase_asks_clarification(monkeypatch):
    async def fake_parse_user_intent(_text):
        return {"intent": "operation_input", "_parser_mode": "ai", "confidence": 0.8}

    async def fake_parse_operations(_text):
        return [
            {
                "operation_type": "закупка",
                "description": "купили монитор 15000",
                "amount": 15000,
                "payment_source": "корп",
                "payment_account": "ИП Каменский АБ",
                "payment_method": "карта",
                "business_direction": "Розница",
                "date": "2026-04-05",
                "_confidence": 0.4,
                "_clarify_question": "Это для клиента/заказа или для офиса/бизнеса?",
                "_parser_mode": "ai",
            }
        ]

    async def fake_log_quality_event(**kwargs):
        return None

    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages, "_log_quality_event", fake_log_quality_event)

    context = DummyContext()
    update = DummyUpdate("купили монитор 15000")
    await messages.handle_text_message(update, context)

    sent = update.message.sent_messages[0]
    assert sent.edits
    assert "клиента" in sent.edits[-1].lower()
    assert messages.PENDING_OPERATION_KEY in context.user_data


@pytest.mark.asyncio
async def test_office_expense_ignores_active_order(monkeypatch):
    async def fake_parse_user_intent(_text):
        return {"intent": "operation_input", "_parser_mode": "ai", "confidence": 0.8}

    async def fake_parse_operations(_text):
        return [
            {
                "operation_type": "расход",
                "description": "купили воду в офис за 840",
                "amount": 840,
                "expense_category": "Офис",
                "payment_source": "корп",
                "payment_account": "ИП Каменский АБ",
                "payment_method": "карта",
                "business_direction": "Розница",
                "date": "2026-04-05",
                "_confidence": 0.95,
                "_parser_mode": "ai",
            }
        ]

    async def fake_log_quality_event(**kwargs):
        return None

    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages, "_log_quality_event", fake_log_quality_event)

    context = DummyContext()
    context.user_data[messages.ACTIVE_ORDER_ID_KEY] = 77
    context.user_data[messages.ACTIVE_CLIENT_ID_KEY] = 17
    context.user_data[messages.ACTIVE_ORDER_PHONE_KEY] = "+79990000000"

    update = DummyUpdate("купили воду в офис за 840")
    await messages.handle_text_message(update, context)

    pending = context.user_data[messages.PENDING_OPERATION_KEY]
    assert pending.get("order_id") is None
    assert context.user_data[messages.PENDING_WAITING_ORDER_PHONE_KEY] is False


@pytest.mark.asyncio
async def test_multi_operations_saved_from_one_message(monkeypatch):
    saved_calls = []

    async def fake_parse_user_intent(_text):
        return {"intent": "operation_input", "_parser_mode": "ai", "confidence": 0.8}

    async def fake_parse_operations(_text):
        return [
            {
                "operation_type": "расход",
                "description": "вода в офис",
                "amount": 840,
                "expense_category": "Офис",
                "payment_source": "корп",
                "payment_account": "ИП Каменский АБ",
                "payment_method": "карта",
                "business_direction": "Розница",
                "date": "2026-04-05",
                "_confidence": 0.95,
                "_parser_mode": "ai",
            },
            {
                "operation_type": "расход",
                "description": "интернет за месяц",
                "amount": 1200,
                "expense_category": "Интернет",
                "payment_source": "корп",
                "payment_account": "ИП Каменский АБ",
                "payment_method": "карта",
                "business_direction": "Розница",
                "date": "2026-04-05",
                "_confidence": 0.95,
                "_parser_mode": "ai",
            },
        ]

    async def fake_save_operation_payload(payload, *, source_text, created_by):
        saved_calls.append((payload, source_text, created_by))
        return 100 + len(saved_calls)

    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages, "_save_operation_payload", fake_save_operation_payload)

    context = DummyContext()
    update = DummyUpdate("купили воду в офис 840 и оплатили интернет 1200")
    await messages.handle_text_message(update, context)

    assert len(saved_calls) == 2
    sent = update.message.sent_messages[0]
    assert "2" in sent.edits[-1]


@pytest.mark.asyncio
async def test_pending_spec_pricing_saves_price_and_finishes(monkeypatch):
    calls = {"saved": None}

    async def fake_get_next_unpriced_spec_item(_spec_id):
        if calls["saved"] is None:
            return {
                "id": 501,
                "item_index": 1,
                "component_name": "Процессор",
                "component_value": "Intel Core i5",
            }
        return None

    async def fake_update_spec_item_price(item_id, amount, status="confirmed", purchase_account=None):
        calls["saved"] = (item_id, amount, status, purchase_account)
        return True

    async def fake_count_unpriced(_spec_id):
        return 0

    async def fake_get_spec_document_by_id(_spec_id):
        return {"id": 1001, "customer_total": 25000}

    async def fake_list_spec_items(_spec_id):
        return [{"purchase_price": 18500}]

    monkeypatch.setattr(messages, "get_next_unpriced_spec_item", fake_get_next_unpriced_spec_item)
    monkeypatch.setattr(messages, "update_spec_item_price", fake_update_spec_item_price)
    monkeypatch.setattr(messages, "count_unpriced_spec_items", fake_count_unpriced)
    monkeypatch.setattr(messages, "get_spec_document_by_id", fake_get_spec_document_by_id)
    monkeypatch.setattr(messages, "list_spec_items", fake_list_spec_items)

    context = DummyContext()
    context.user_data[messages.PENDING_SPEC_PRICING_KEY] = {
        "spec_document_id": 1001,
        "order_id": 77,
        "client_id": 55,
        "current_item_id": None,
        "current_item_account": None,
        "awaiting_finalize": False,
        "awaiting_loss_confirm": False,
    }
    update_account = DummyUpdate("1")
    await messages.handle_text_message(update_account, context)
    update_price = DummyUpdate("18500")
    await messages.handle_text_message(update_price, context)

    assert calls["saved"] == (501, 18500.0, "confirmed", "ИП Каменский АБ")


@pytest.mark.asyncio
async def test_pending_spec_sale_confirmation_creates_operation(monkeypatch):
    captured = {}

    async def fake_get_order_by_id(order_id):
        assert order_id == 77
        return {"id": 77, "order_phone": "+79990001122"}

    async def fake_save_operation_payload(payload, *, source_text, created_by):
        captured["payload"] = payload
        captured["source_text"] = source_text
        captured["created_by"] = created_by
        return 888

    async def fake_get_primary_spec_document_for_order(_order_id):
        return {"id": 12, "parse_status": "parsed"}

    async def fake_count_unpriced_spec_items(_spec_document_id):
        return 0

    monkeypatch.setattr(messages, "get_order_by_id", fake_get_order_by_id)
    monkeypatch.setattr(messages, "_save_operation_payload", fake_save_operation_payload)
    monkeypatch.setattr(messages, "get_primary_spec_document_for_order", fake_get_primary_spec_document_for_order)
    monkeypatch.setattr(messages, "count_unpriced_spec_items", fake_count_unpriced_spec_items)

    context = DummyContext()
    context.user_data[messages.PENDING_SPEC_SALE_KEY] = {
        "spec_document_id": 12,
        "order_id": 77,
        "client_id": 55,
        "amount": 99990,
        "description": "Продажа по спецификации spec.docx",
        "sale_type": "Сборка",
    }
    update = DummyUpdate("ок продажа")
    await messages.handle_text_message(update, context)

    assert captured["payload"]["operation_type"] == "продажа"
    assert captured["payload"]["amount"] == 99990
    assert messages.PENDING_SPEC_SALE_KEY not in context.user_data
    assert any("(#888)" in text for text in update.message.reply_calls)


def test_normalize_parsed_data_defaults_purchase_account_to_ip_ab():
    normalized = messages._normalize_parsed_data(
        {
            "operation_type": "закупка",
            "description": "закупка блока питания",
            "amount": 12000,
            "payment_account": "",
        }
    )

    assert normalized["payment_account"] == "ИП Каменский АБ"


def test_missing_fields_requires_account_for_expense():
    normalized = messages._normalize_parsed_data(
        {
            "operation_type": "расход",
            "description": "аренда офиса",
            "amount": 50000,
            "payment_account": "",
        }
    )

    missing = messages._missing_fields(normalized)
    assert "payment_account" in missing
