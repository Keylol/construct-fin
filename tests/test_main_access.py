import pytest

from bot import main


class DummyMessage:
    def __init__(self, text: str):
        self.text = text
        self.reply_calls = []

    async def reply_text(self, text, **kwargs):
        self.reply_calls.append(text)
        return None


class DummyUser:
    def __init__(self, user_id=100):
        self.id = user_id
        self.first_name = "Operator"
        self.username = "operator"


class DummyUpdate:
    def __init__(self, text="/sheetsetup", user_id=100):
        self.effective_user = DummyUser(user_id=user_id)
        self.message = DummyMessage(text=text)


class DummyContext:
    def __init__(self):
        self.args = []
        self.user_data = {}


@pytest.mark.asyncio
async def test_owner_only_command_is_blocked_for_operator(monkeypatch):
    called = {"sheetsetup": False}

    async def fake_sheetsetup():
        called["sheetsetup"] = True
        return {"spreadsheet_url": "x", "created": False}

    async def fake_audit(*args, **kwargs):
        return 1

    monkeypatch.setattr(main, "setup_management_spreadsheet", fake_sheetsetup)
    monkeypatch.setattr(main, "add_audit_log", fake_audit)
    monkeypatch.setattr(main.config, "resolve_user_role", lambda _uid: "operator")
    monkeypatch.setattr(main.config, "is_command_allowed", lambda _role, _cmd: False)

    update = DummyUpdate("/sheetsetup")
    context = DummyContext()
    await main.cmd_sheetsetup(update, context)

    assert called["sheetsetup"] is False
    assert any("только роли owner" in text.lower() for text in update.message.reply_calls)
