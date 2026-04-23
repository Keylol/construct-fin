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
    def __init__(self, user_id=99):
        self.id = user_id
        self.first_name = "Owner"
        self.username = "owner"


class DummyUpdate:
    def __init__(self, text, user_id=99):
        self.message = DummyIncomingMessage(text)
        self.effective_user = DummyUser(user_id=user_id)


class DummyContext:
    def __init__(self):
        self.user_data = {}


@pytest.mark.asyncio
async def test_wipe_flow_requests_pin_and_runs_on_correct_code(monkeypatch):
    async def fake_parse_user_intent(_text):
        return {"intent": "other", "confidence": 0.1}

    async def fake_parse_operations(_text):
        return []

    async def fake_wipe_all_business_data():
        return {
            "operations": 3,
            "customer_orders": 2,
            "clients": 2,
            "documents": 0,
            "spec_documents": 0,
            "spec_items": 0,
            "recognition_logs": 1,
        }

    async def fake_reset_management_spreadsheet():
        return {"ok": True}

    async def fake_audit(*args, **kwargs):
        return 1

    monkeypatch.setattr(messages.ai_parser, "parse_user_intent", fake_parse_user_intent)
    monkeypatch.setattr(messages.ai_parser, "parse_operations", fake_parse_operations)
    monkeypatch.setattr(messages, "wipe_all_business_data", fake_wipe_all_business_data)
    monkeypatch.setattr(messages, "reset_management_spreadsheet", fake_reset_management_spreadsheet)
    monkeypatch.setattr(messages, "add_audit_log", fake_audit)

    context = DummyContext()
    context.user_data["user_role"] = "owner"

    update_trigger = DummyUpdate("1100")
    await messages.handle_text_message(update_trigger, context)

    assert messages.PENDING_WIPE_KEY in context.user_data
    assert any("pin" in text.lower() for text in update_trigger.message.reply_calls)

    update_confirm = DummyUpdate("0011")
    await messages.handle_text_message(update_confirm, context)

    assert messages.PENDING_WIPE_KEY not in context.user_data
    assert any("зачистка выполнена" in text.lower() for text in update_confirm.message.reply_calls)


@pytest.mark.asyncio
async def test_wipe_flow_denies_operator(monkeypatch):
    async def fake_audit(*args, **kwargs):
        return 1

    monkeypatch.setattr(messages, "add_audit_log", fake_audit)

    context = DummyContext()
    context.user_data["user_role"] = "operator"
    update = DummyUpdate("1100")

    await messages.handle_text_message(update, context)

    assert messages.PENDING_WIPE_KEY not in context.user_data
    assert any("только роли owner" in text.lower() for text in update.message.reply_calls)
