import pytest

from bot import main


class DummyMessage:
    def __init__(self):
        self.reply_calls = []

    async def reply_text(self, text, **kwargs):
        self.reply_calls.append(text)
        return None


class DummyUser:
    def __init__(self, user_id=99):
        self.id = user_id
        self.first_name = "Manager"
        self.username = "manager"


class DummyUpdate:
    def __init__(self, user_id=99):
        self.effective_user = DummyUser(user_id=user_id)
        self.message = DummyMessage()


class DummyContext:
    def __init__(self, args=None):
        self.args = args or []
        self.user_data = {}


@pytest.mark.asyncio
async def test_cmd_delete_queues_confirmation_by_id(monkeypatch):
    captured = {}
    monkeypatch.setattr(main.config, "ALLOWED_USER_IDS", [])
    monkeypatch.setattr(main.config, "resolve_user_role", lambda _user_id: "owner")

    async def fake_queue_delete_confirmation(update, context, *, target_id, requested_by):
        captured["target_id"] = target_id
        captured["requested_by"] = requested_by
        return True

    monkeypatch.setattr(main, "queue_delete_confirmation", fake_queue_delete_confirmation)

    update = DummyUpdate(user_id=42)
    context = DummyContext(args=["123"])
    await main.cmd_delete(update, context)

    assert captured["target_id"] == 123
    assert captured["requested_by"] == 42


@pytest.mark.asyncio
async def test_cmd_delete_last_without_operations(monkeypatch):
    monkeypatch.setattr(main.config, "ALLOWED_USER_IDS", [])
    monkeypatch.setattr(main.config, "resolve_user_role", lambda _user_id: "owner")
    async def fake_get_last_operation(created_by=None):
        return None

    monkeypatch.setattr(main, "get_last_operation", fake_get_last_operation)

    update = DummyUpdate(user_id=42)
    context = DummyContext(args=["last"])
    await main.cmd_delete(update, context)

    assert any("не нашел" in text.lower() for text in update.message.reply_calls)
