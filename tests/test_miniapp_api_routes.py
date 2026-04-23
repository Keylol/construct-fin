from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import json
import zipfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient

import config as legacy_config
from miniapp_api.app.config import get_settings
from miniapp_api.app.db import dispose_engine
from miniapp_api.app.main import create_app


def _build_init_data(*, bot_token: str, user_id: int, first_name: str, auth_date: int | None = None) -> str:
    ts = auth_date or int(datetime.now(tz=UTC).timestamp())
    user = {"id": user_id, "first_name": first_name, "username": f"user_{user_id}", "language_code": "ru"}
    payload = {
        "auth_date": str(ts),
        "query_id": f"AA_TEST_{user_id}",
        "user": json.dumps(user, ensure_ascii=False, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(payload.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    payload["hash"] = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    return urlencode(payload)


def _auth(client: TestClient, *, bot_token: str, user_id: int, first_name: str) -> str:
    init_data = _build_init_data(bot_token=bot_token, user_id=user_id, first_name=first_name)
    response = client.post("/api/v1/auth/telegram", json={"initData": init_data})
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


@pytest.fixture
def miniapp_test_client(tmp_path, monkeypatch):
    db_path = tmp_path / "miniapp_routes.db"
    bot_token = "123456:TEST_TOKEN"
    docs_dir = tmp_path / "miniapp_docs"

    monkeypatch.setenv("MINIAPP_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setenv("MINIAPP_DOCUMENTS_DIR", str(docs_dir))
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", bot_token)
    monkeypatch.setenv("JWT_SECRET", "test_jwt_secret_long_enough_for_hs256")
    monkeypatch.setenv("OWNER_USER_IDS", "777")
    monkeypatch.setenv("OPERATOR_USER_IDS", "888")
    monkeypatch.setenv("ALLOWED_USER_IDS", "")
    monkeypatch.setenv("MINIAPP_SOFT_LAUNCH_OWNER_ONLY", "0")
    monkeypatch.setenv("MINIAPP_MAX_UPLOAD_MB", "50")
    monkeypatch.setenv("MINIAPP_REPORT_DEFAULT_DAYS", "7")
    monkeypatch.setattr(legacy_config, "AI_RUNTIME_STATE_PATH", tmp_path / "ai_runtime.json")
    monkeypatch.setattr(
        legacy_config,
        "AI_MODEL_OPTIONS",
        ["gpt-5.4-mini", "gpt-5.4", "gpt-5-mini", "claude-sonnet-4.6", "gemini-2.5-flash"],
    )
    monkeypatch.setattr(legacy_config, "AI_MODEL", "gpt-5.4-mini")

    get_settings.cache_clear()
    asyncio.run(dispose_engine())

    app = create_app()
    with TestClient(app) as client:
        yield client

    asyncio.run(dispose_engine())
    get_settings.cache_clear()


def test_auth_denies_unknown_user(miniapp_test_client):
    init_data = _build_init_data(bot_token="123456:TEST_TOKEN", user_id=999, first_name="Blocked")
    response = miniapp_test_client.post("/api/v1/auth/telegram", json={"initData": init_data})
    assert response.status_code == 403
    assert response.json()["detail"] == "Access denied for this Telegram user"


def test_owner_end_to_end_flow(miniapp_test_client, monkeypatch):
    async def _fake_parse_operation(_: str) -> dict:
        return {
            "date": "2026-04-13",
            "operation_type": "расход",
            "description": "parsed operation",
            "amount": 1200.0,
            "expense_category": "Офис",
            "expense_subcategory": "Канцелярия",
            "payment_account": "ИП Каменский АБ",
            "payment_method": "cash",
        }

    monkeypatch.setattr("miniapp_api.app.routes.operations.parse_operation", _fake_parse_operation)

    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    create_order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000001", "client_name": "Client A"},
    )
    assert create_order.status_code == 200, create_order.text
    order_id = create_order.json()["id"]

    create_manual_op = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "продажа",
            "description": "manual op",
            "amount": 55000,
            "order_id": order_id,
        },
    )
    assert create_manual_op.status_code == 200, create_manual_op.text
    assert create_manual_op.json()["amount"] == 55000

    create_text_op = miniapp_test_client.post(
        "/api/v1/operations/from-text",
        headers=headers,
        json={"text": "купил мышь за 1200", "order_id": order_id},
    )
    assert create_text_op.status_code == 200, create_text_op.text
    assert create_text_op.json()["description"] == "parsed operation"

    orders = miniapp_test_client.get("/api/v1/orders", headers=headers)
    assert orders.status_code == 200
    assert len(orders.json()) == 1

    operations = miniapp_test_client.get("/api/v1/operations", headers=headers)
    assert operations.status_code == 200
    assert len(operations.json()) == 2

    order_operations = miniapp_test_client.get(f"/api/v1/operations?order_id={order_id}", headers=headers)
    assert order_operations.status_code == 200, order_operations.text
    assert len(order_operations.json()) == 2

    close_order = miniapp_test_client.post(f"/api/v1/orders/{order_id}/close", headers=headers)
    assert close_order.status_code == 200, close_order.text
    assert close_order.json()["status"] == "closed"

    reopen_order = miniapp_test_client.post(f"/api/v1/orders/{order_id}/reopen", headers=headers)
    assert reopen_order.status_code == 200, reopen_order.text
    assert reopen_order.json()["status"] == "open"


def test_order_identity_can_be_updated(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    created = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000011", "client_name": "Client Before"},
    )
    assert created.status_code == 200, created.text
    order_id = created.json()["id"]

    updated = miniapp_test_client.put(
        f"/api/v1/orders/{order_id}",
        headers=headers,
        json={"order_phone": "+79990000022", "client_name": "Client After"},
    )
    assert updated.status_code == 200, updated.text
    payload = updated.json()
    assert payload["order_phone"] == "+79990000022"
    assert payload["client_name"] == "Client After"


def test_operator_cannot_use_foreign_order(miniapp_test_client):
    owner_token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    owner_headers = {"Authorization": f"Bearer {owner_token}"}
    owner_order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=owner_headers,
        json={"order_phone": "+79990000002", "client_name": "Owner Client"},
    )
    assert owner_order.status_code == 200, owner_order.text
    order_id = owner_order.json()["id"]

    operator_token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=888, first_name="Operator")
    operator_headers = {"Authorization": f"Bearer {operator_token}"}

    forbidden = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=operator_headers,
        json={
            "operation_type": "расход",
            "description": "try foreign order",
            "amount": 100,
            "order_id": order_id,
            "expense_category": "Офис",
            "expense_subcategory": "Канцелярия",
            "payment_account": "ИП Каменский АБ",
        },
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["detail"] == "No access to this order"

    owner_operation = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=owner_headers,
        json={
            "operation_type": "закупка",
            "description": "owner purchase",
            "amount": 500,
            "order_id": order_id,
            "payment_account": "ИП Каменский АБ",
        },
    )
    assert owner_operation.status_code == 200, owner_operation.text

    delete_forbidden = miniapp_test_client.delete(
        f"/api/v1/operations/{owner_operation.json()['id']}",
        headers=operator_headers,
    )
    assert delete_forbidden.status_code == 403
    assert delete_forbidden.json()["detail"] == "No access to this order"

    update_forbidden = miniapp_test_client.put(
        f"/api/v1/orders/{order_id}",
        headers=operator_headers,
        json={"client_name": "Hijack"},
    )
    assert update_forbidden.status_code == 403
    assert update_forbidden.json()["detail"] == "No access to this order"


def test_meta_options_available(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}
    response = miniapp_test_client.get("/api/v1/meta/options", headers=headers)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "operation_types" in payload
    assert "расход" in payload["operation_types"]
    assert "payment_accounts" in payload and len(payload["payment_accounts"]) >= 1


def test_operation_preview_validation(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    response = miniapp_test_client.post(
        "/api/v1/operations/preview/manual",
        headers=headers,
        json={
            "operation_type": "расход",
            "description": "Офисный расход",
            "amount": 1200,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready_to_save"] is False
    assert "payment_account" in body["missing_fields"]

    invalid_income = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "продажа",
            "description": "Продажа без заказа",
            "amount": 10000,
        },
    )
    assert invalid_income.status_code == 422
    assert "missing_fields" in invalid_income.json()["detail"]
    assert "order_id" in invalid_income.json()["detail"]["missing_fields"]


def test_owner_can_delete_operation(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}
    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000003", "client_name": "Delete Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    operation = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "закупка",
            "description": "Delete me",
            "amount": 1200,
            "order_id": order_id,
            "payment_account": "ИП Каменский АБ",
        },
    )
    assert operation.status_code == 200, operation.text
    operation_id = operation.json()["id"]

    delete_response = miniapp_test_client.delete(f"/api/v1/operations/{operation_id}", headers=headers)
    assert delete_response.status_code == 204, delete_response.text

    operations = miniapp_test_client.get(f"/api/v1/operations?order_id={order_id}", headers=headers)
    assert operations.status_code == 200, operations.text
    assert operations.json() == []

    audit_logs = miniapp_test_client.get("/api/v1/audit/logs?limit=20", headers=headers)
    assert audit_logs.status_code == 200, audit_logs.text
    assert any(
        item["action"] == "operation_deleted" and item["entity_id"] == operation_id
        for item in audit_logs.json()
    )


def test_owner_can_update_business_expense(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    created = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "расход",
            "description": "Офисный расход",
            "amount": 1500,
            "expense_category": "Офис",
            "payment_account": "ИП Каменский АБ",
        },
    )
    assert created.status_code == 200, created.text
    operation_id = created.json()["id"]

    updated = miniapp_test_client.put(
        f"/api/v1/operations/{operation_id}",
        headers=headers,
        json={
            "operation_type": "расход",
            "description": "Офисный расход обновлен",
            "amount": 1750,
            "date": "2026-04-16",
            "expense_category": "Офис",
            "payment_account": "ИП Каменский АБ",
            "payment_method": "карта",
        },
    )
    assert updated.status_code == 200, updated.text
    payload = updated.json()
    assert payload["description"] == "Офисный расход обновлен"
    assert payload["amount"] == 1750.0
    assert payload["expense_category"] == "Офис"


def test_reports_summary_and_timeseries(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}
    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000077", "client_name": "Report Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    sale = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "продажа",
            "description": "Продажа",
            "amount": 1000,
            "order_id": order_id,
        },
    )
    assert sale.status_code == 200, sale.text

    cash_received = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "оплата",
            "description": "Полная оплата",
            "amount": 1000,
            "order_id": order_id,
        },
    )
    assert cash_received.status_code == 200, cash_received.text

    purchase = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "закупка",
            "description": "Закупка",
            "amount": 400,
            "order_id": order_id,
            "payment_account": "ИП Каменский АБ",
        },
    )
    assert purchase.status_code == 200, purchase.text

    cogs = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "себестоимость",
            "description": "Себестоимость заказа",
            "amount": 400,
            "order_id": order_id,
        },
    )
    assert cogs.status_code == 200, cogs.text

    expense = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "расход",
            "description": "Реклама",
            "amount": 100,
            "date": (date.today() + timedelta(days=1)).isoformat(),
            "expense_category": "Реклама",
            "expense_subcategory": "Таргет",
            "payment_account": "ИП Каменский АБ",
        },
    )
    assert expense.status_code == 200, expense.text

    close_order = miniapp_test_client.post(f"/api/v1/orders/{order_id}/close", headers=headers)
    assert close_order.status_code == 200, close_order.text

    summary = miniapp_test_client.get("/api/v1/reports/summary?days=30", headers=headers)
    assert summary.status_code == 200, summary.text
    summary_payload = summary.json()
    assert summary_payload["income"] == 1000.0
    assert summary_payload["average_ticket"] == 1000.0
    assert summary_payload["cash_received"] == 1000.0
    assert summary_payload["purchases"] == 400.0
    assert summary_payload["other_expenses"] == 100.0
    assert summary_payload["commercial_expenses"] == 100.0
    assert summary_payload["total_expenses"] == 500.0
    assert summary_payload["profit"] == 500.0
    assert summary_payload["open_orders_count"] == 0
    assert summary_payload["wip_amount"] == 0.0
    assert summary_payload["operations_count"] == 5

    timeseries = miniapp_test_client.get("/api/v1/reports/timeseries?days=30", headers=headers)
    assert timeseries.status_code == 200, timeseries.text
    points = timeseries.json()
    assert len(points) >= 1
    assert {"date", "income", "cash_received", "expenses", "profit"}.issubset(points[0].keys())


def test_reports_keep_open_order_in_revenue_and_wip(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}
    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000066", "client_name": "Open Report Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    sale = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "продажа",
            "description": "Открытая продажа",
            "amount": 1000,
            "order_id": order_id,
        },
    )
    assert sale.status_code == 200, sale.text

    prepayment = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "предоплата",
            "description": "Предоплата",
            "amount": 300,
            "order_id": order_id,
        },
    )
    assert prepayment.status_code == 200, prepayment.text

    purchase = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "закупка",
            "description": "Закупка в незавершенку",
            "amount": 400,
            "order_id": order_id,
            "payment_account": "ИП Каменский АБ",
        },
    )
    assert purchase.status_code == 200, purchase.text

    summary = miniapp_test_client.get("/api/v1/reports/summary?days=30", headers=headers)
    assert summary.status_code == 200, summary.text
    summary_payload = summary.json()
    assert summary_payload["income"] == 0.0
    assert summary_payload["average_ticket"] == 0.0
    assert summary_payload["cash_received"] == 300.0
    assert summary_payload["purchases"] == 0.0
    assert summary_payload["other_expenses"] == 0.0
    assert summary_payload["profit"] == 0.0
    assert summary_payload["open_orders_count"] == 1
    assert summary_payload["open_orders_revenue"] == 1000.0
    assert summary_payload["open_orders_balance_due"] == 700.0
    assert summary_payload["wip_amount"] == 400.0


def test_orders_list_exposes_finance_and_problem_metadata(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000055", "client_name": "Metadata Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    sale = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "продажа",
            "description": "Исходная продажа",
            "amount": 1000,
            "order_id": order_id,
        },
    )
    assert sale.status_code == 200, sale.text

    correction = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "корректировка продажи",
            "description": "Изменение: корректировка суммы",
            "amount": 100,
            "order_id": order_id,
        },
    )
    assert correction.status_code == 200, correction.text

    upload = miniapp_test_client.post(
        "/api/v1/documents",
        headers=headers,
        data={"order_id": str(order_id), "doc_type": "чек"},
        files={"file": ("receipt.pdf", io.BytesIO(b"%PDF-1.4 meta"), "application/pdf")},
    )
    assert upload.status_code == 200, upload.text

    orders = miniapp_test_client.get("/api/v1/orders", headers=headers)
    assert orders.status_code == 200, orders.text
    payload = orders.json()
    current = next(item for item in payload if item["id"] == order_id)
    assert current["sale_amount"] == 1100.0
    assert current["documents_count"] == 1
    assert current["has_changes"] is True
    assert current["last_activity_at"]


def test_documents_upload_and_dedup(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}
    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000088", "client_name": "Docs Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    file_payload = io.BytesIO(b"%PDF-1.4 fake-content")
    upload = miniapp_test_client.post(
        "/api/v1/documents",
        headers=headers,
        data={"order_id": str(order_id), "doc_type": "чек"},
        files={"file": ("receipt.pdf", file_payload, "application/pdf")},
    )
    assert upload.status_code == 200, upload.text
    first_doc = upload.json()
    assert first_doc["order_id"] == order_id
    assert first_doc["doc_type"] == "чек"

    file_payload_2 = io.BytesIO(b"%PDF-1.4 fake-content")
    duplicate = miniapp_test_client.post(
        "/api/v1/documents",
        headers=headers,
        data={"order_id": str(order_id), "doc_type": "чек"},
        files={"file": ("receipt-copy.pdf", file_payload_2, "application/pdf")},
    )
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["id"] == first_doc["id"]

    listed = miniapp_test_client.get(f"/api/v1/documents?order_id={order_id}", headers=headers)
    assert listed.status_code == 200
    docs = listed.json()
    assert len(docs) == 1


def test_documents_download_and_export_zip(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}
    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000089", "client_name": "Zip Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    upload = miniapp_test_client.post(
        "/api/v1/documents",
        headers=headers,
        data={"order_id": str(order_id), "doc_type": "чек"},
        files={"file": ("receipt.pdf", io.BytesIO(b"%PDF-1.4 zip-content"), "application/pdf")},
    )
    assert upload.status_code == 200, upload.text
    document_id = upload.json()["id"]

    single = miniapp_test_client.get(f"/api/v1/documents/{document_id}/download", headers=headers)
    assert single.status_code == 200, single.text
    assert "attachment" in (single.headers.get("content-disposition") or "").lower()
    assert single.content.startswith(b"%PDF-1.4")

    export = miniapp_test_client.get(f"/api/v1/documents/order/{order_id}/export", headers=headers)
    assert export.status_code == 200, export.text
    assert "application/zip" in (export.headers.get("content-type") or "")
    with zipfile.ZipFile(io.BytesIO(export.content)) as archive:
        names = archive.namelist()
        assert names == ["receipt.pdf"]
        assert archive.read("receipt.pdf").startswith(b"%PDF-1.4")


def test_documents_export_all_zip(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    first_order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000101", "client_name": "Export One"},
    )
    assert first_order.status_code == 200, first_order.text
    first_order_id = first_order.json()["id"]

    second_order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000102", "client_name": "Export Two"},
    )
    assert second_order.status_code == 200, second_order.text
    second_order_id = second_order.json()["id"]

    first_upload = miniapp_test_client.post(
        "/api/v1/documents",
        headers=headers,
        data={"order_id": str(first_order_id), "doc_type": "чек"},
        files={"file": ("receipt.pdf", io.BytesIO(b"%PDF-1.4 first"), "application/pdf")},
    )
    assert first_upload.status_code == 200, first_upload.text

    second_upload = miniapp_test_client.post(
        "/api/v1/documents",
        headers=headers,
        data={"order_id": str(second_order_id), "doc_type": "спецификация"},
        files={
            "file": (
                "spec.docx",
                io.BytesIO(b"fake-docx-second"),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert second_upload.status_code == 200, second_upload.text

    export = miniapp_test_client.get("/api/v1/documents/export/all", headers=headers)
    assert export.status_code == 200, export.text
    assert "application/zip" in (export.headers.get("content-type") or "")
    with zipfile.ZipFile(io.BytesIO(export.content)) as archive:
        names = sorted(archive.namelist())
        assert names == [
            f"order_{first_order_id}/{first_upload.json()['id']}_receipt.pdf",
            f"order_{second_order_id}/{second_upload.json()['id']}_spec.docx",
        ]
        assert archive.read(names[0]).startswith(b"%PDF-1.4")
        assert archive.read(names[1]).startswith(b"fake-docx")


def test_document_assist_for_specification(miniapp_test_client, monkeypatch):
    async def _fake_parse_spec_file(_path):
        return {
            "items": [
                {"component_name": "CPU", "component_value": "Ryzen 7 7800X3D", "confidence": 0.91},
                {"component_name": "GPU", "component_value": "RTX 4070 Super", "confidence": 0.89},
            ],
            "customer_total": 125000.0,
            "customer_name": "Иван Иванов",
            "order_phone": "+79990000090",
        }

    monkeypatch.setattr("miniapp_api.app.services.document_assist.parse_spec_file", _fake_parse_spec_file)

    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}
    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000090", "client_name": "Spec Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    upload = miniapp_test_client.post(
        "/api/v1/documents",
        headers=headers,
        data={"order_id": str(order_id), "doc_type": "спецификация"},
        files={
            "file": (
                "spec.docx",
                io.BytesIO(b"fake-docx"),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert upload.status_code == 200, upload.text
    document_id = upload.json()["id"]

    assist = miniapp_test_client.post(f"/api/v1/documents/{document_id}/assist", headers=headers)
    assert assist.status_code == 200, assist.text
    payload = assist.json()

    assert payload["mode"] == "spec"
    assert payload["title"] == "Предложение по спецификации"
    assert payload["customer_total"] == 125000.0
    assert payload["customer_name"] == "Иван Иванов"
    assert payload["order_phone"] == "+79990000090"
    assert "CPU: Ryzen 7 7800X3D" in payload["items_preview"]
    assert payload["parsed_items"][0]["component_name"] == "CPU"
    assert payload["parsed_items"][0]["component_value"] == "Ryzen 7 7800X3D"
    assert any("Телефон в документе совпадает" in line for line in payload["highlights"])
    assert "Проверьте комплектующие и перенесите их в заказ" in payload["suggested_actions"]
    assert "Проверьте и внесите цену продажи из спецификации" in payload["suggested_actions"]


def test_document_assist_for_receipt(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}
    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000091", "client_name": "Receipt Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    upload = miniapp_test_client.post(
        "/api/v1/documents",
        headers=headers,
        data={"order_id": str(order_id), "doc_type": "чек"},
        files={"file": ("receipt.pdf", io.BytesIO(b"%PDF-1.4 receipt"), "application/pdf")},
    )
    assert upload.status_code == 200, upload.text
    document_id = upload.json()["id"]

    assist = miniapp_test_client.post(f"/api/v1/documents/{document_id}/assist", headers=headers)
    assert assist.status_code == 200, assist.text
    payload = assist.json()

    assert payload["mode"] == "receipt"
    assert payload["title"] == "Похоже на чек закупки"
    assert "Добавьте закупку к заказу" in payload["suggested_actions"]
    assert payload["items_preview"] == []
    assert payload["parsed_items"] == []


def test_owner_can_delete_order_with_related_data(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}
    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000110", "client_name": "Delete Order Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    operation = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "закупка",
            "description": "Delete order purchase",
            "amount": 3000,
            "order_id": order_id,
            "payment_account": "ИП Каменский АБ",
        },
    )
    assert operation.status_code == 200, operation.text

    upload = miniapp_test_client.post(
        "/api/v1/documents",
        headers=headers,
        data={"order_id": str(order_id), "doc_type": "чек"},
        files={"file": ("delete.pdf", io.BytesIO(b"%PDF-1.4 delete"), "application/pdf")},
    )
    assert upload.status_code == 200, upload.text
    stored_path = upload.json()["file_path"]

    deleted = miniapp_test_client.delete(f"/api/v1/orders/{order_id}", headers=headers)
    assert deleted.status_code == 204, deleted.text

    orders = miniapp_test_client.get("/api/v1/orders", headers=headers)
    assert orders.status_code == 200, orders.text
    assert all(item["id"] != order_id for item in orders.json())

    order_ops = miniapp_test_client.get(f"/api/v1/operations?order_id={order_id}", headers=headers)
    assert order_ops.status_code == 404

    assert Path(stored_path).exists()

    audit_logs = miniapp_test_client.get("/api/v1/audit/logs?limit=20", headers=headers)
    assert audit_logs.status_code == 200, audit_logs.text
    assert any(
        item["action"] == "order_deleted" and item["entity_id"] == order_id
        for item in audit_logs.json()
    )


def test_operator_cannot_delete_own_order(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=888, first_name="Operator")
    headers = {"Authorization": f"Bearer {token}"}
    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000112", "client_name": "Operator Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    deleted = miniapp_test_client.delete(f"/api/v1/orders/{order_id}", headers=headers)
    assert deleted.status_code == 403, deleted.text
    assert deleted.json()["detail"] == "Insufficient role"
    
    orders = miniapp_test_client.get("/api/v1/orders", headers=headers)
    assert orders.status_code == 200, orders.text
    assert any(item["id"] == order_id for item in orders.json())


def test_owner_can_view_audit_logs_and_operator_cannot(miniapp_test_client):
    owner_token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    owner_headers = {"Authorization": f"Bearer {owner_token}"}

    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=owner_headers,
        json={"order_phone": "+79990000113", "client_name": "Audit Client"},
    )
    assert order.status_code == 200, order.text

    logs = miniapp_test_client.get("/api/v1/audit/logs?limit=10", headers=owner_headers)
    assert logs.status_code == 200, logs.text
    assert any(item["action"] == "order_created" for item in logs.json())

    operator_token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=888, first_name="Operator")
    operator_headers = {"Authorization": f"Bearer {operator_token}"}
    forbidden = miniapp_test_client.get("/api/v1/audit/logs?limit=10", headers=operator_headers)
    assert forbidden.status_code == 403


def test_owner_can_sync_google_sheets_from_miniapp(miniapp_test_client, monkeypatch):
    captured: dict[str, object] = {}

    async def _fake_sync(operations):
        captured["operations"] = operations
        return {
            "spreadsheet_id": "sheet_123",
            "spreadsheet_url": "https://docs.google.com/spreadsheets/d/sheet_123",
            "created": False,
            "months": ["2026-04"],
        }

    monkeypatch.setattr("miniapp_api.app.services.google_sheets.sync_management_spreadsheet_from_operations", _fake_sync)

    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000114", "client_name": "Sheets Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    operation = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "закупка",
            "description": "Sheets purchase",
            "amount": 2100,
            "order_id": order_id,
            "payment_account": "ИП Каменский АБ",
        },
    )
    assert operation.status_code == 200, operation.text

    response = miniapp_test_client.post("/api/v1/admin/google-sheets/sync", headers=headers)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["spreadsheet_id"] == "sheet_123"
    assert payload["operations_exported"] == 1
    assert payload["review_items"] == 1

    exported = captured["operations"]
    assert isinstance(exported, list) and len(exported) == 1
    row = exported[0]
    assert row["source_system"] == "miniapp"
    assert row["client_name"] == "Sheets Client"
    assert row["order_phone"] == "+79990000114"
    assert "Заказ не закрыт" in row["review_flags"]
    assert "Нет файлов по заказу" in row["review_flags"]
    assert "Нет цены продажи" in row["review_flags"]


def test_operator_cannot_sync_google_sheets(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=888, first_name="Operator")
    headers = {"Authorization": f"Bearer {token}"}

    response = miniapp_test_client.post("/api/v1/admin/google-sheets/sync", headers=headers)
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == "Insufficient role"


def test_owner_can_get_and_switch_ai_model(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    current = miniapp_test_client.get("/api/v1/admin/ai-model", headers=headers)
    assert current.status_code == 200, current.text
    assert current.json()["active_model"] == "gpt-5.4-mini"
    assert "gpt-5.4" in current.json()["available_models"]

    switched = miniapp_test_client.post(
        "/api/v1/admin/ai-model",
        headers=headers,
        json={"model": "gpt-5.4"},
    )
    assert switched.status_code == 200, switched.text
    assert switched.json()["active_model"] == "gpt-5.4"

    refreshed = miniapp_test_client.get("/api/v1/admin/ai-model", headers=headers)
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["active_model"] == "gpt-5.4"


def test_operator_cannot_switch_ai_model(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=888, first_name="Operator")
    headers = {"Authorization": f"Bearer {token}"}

    forbidden = miniapp_test_client.get("/api/v1/admin/ai-model", headers=headers)
    assert forbidden.status_code == 403

    forbidden_update = miniapp_test_client.post(
        "/api/v1/admin/ai-model",
        headers=headers,
        json={"model": "gpt-5.4"},
    )
    assert forbidden_update.status_code == 403


def test_reports_export_csv(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    order = miniapp_test_client.post(
        "/api/v1/orders",
        headers=headers,
        json={"order_phone": "+79990000111", "client_name": "Export Client"},
    )
    assert order.status_code == 200, order.text
    order_id = order.json()["id"]

    operation = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={
            "operation_type": "продажа",
            "description": "CSV sale",
            "amount": 7777,
            "order_id": order_id,
        },
    )
    assert operation.status_code == 200, operation.text

    export = miniapp_test_client.get("/api/v1/reports/export.csv?days=7", headers=headers)
    assert export.status_code == 200, export.text
    assert "text/csv" in (export.headers.get("content-type") or "")
    assert "operation_type" in export.text
    assert "CSV sale" in export.text


def test_document_upload_size_limit(tmp_path, monkeypatch):
    db_path = tmp_path / "miniapp_size_limit.db"
    docs_dir = tmp_path / "miniapp_docs_size_limit"
    bot_token = "123456:TEST_TOKEN"

    monkeypatch.setenv("MINIAPP_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setenv("MINIAPP_DOCUMENTS_DIR", str(docs_dir))
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", bot_token)
    monkeypatch.setenv("JWT_SECRET", "test_jwt_secret_long_enough_for_hs256")
    monkeypatch.setenv("OWNER_USER_IDS", "777")
    monkeypatch.setenv("OPERATOR_USER_IDS", "")
    monkeypatch.setenv("ALLOWED_USER_IDS", "")
    monkeypatch.setenv("MINIAPP_SOFT_LAUNCH_OWNER_ONLY", "0")
    monkeypatch.setenv("MINIAPP_MAX_UPLOAD_MB", "1")

    get_settings.cache_clear()
    asyncio.run(dispose_engine())
    app = create_app()
    with TestClient(app) as client:
        token = _auth(client, bot_token=bot_token, user_id=777, first_name="Owner")
        headers = {"Authorization": f"Bearer {token}"}
        order = client.post(
            "/api/v1/orders",
            headers=headers,
            json={"order_phone": "+79990000112", "client_name": "BigFile Client"},
        )
        assert order.status_code == 200, order.text
        order_id = order.json()["id"]

        big_file = io.BytesIO(b"x" * (1024 * 1024 + 10))
        upload = client.post(
            "/api/v1/documents",
            headers=headers,
            data={"order_id": str(order_id), "doc_type": "чек"},
            files={"file": ("big.pdf", big_file, "application/pdf")},
        )
        assert upload.status_code == 413, upload.text

    asyncio.run(dispose_engine())
    get_settings.cache_clear()


def test_soft_launch_owner_only_blocks_operator(tmp_path, monkeypatch):
    db_path = tmp_path / "miniapp_owner_only.db"
    docs_dir = tmp_path / "miniapp_owner_only_docs"
    bot_token = "123456:TEST_TOKEN"

    monkeypatch.setenv("MINIAPP_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setenv("MINIAPP_DOCUMENTS_DIR", str(docs_dir))
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", bot_token)
    monkeypatch.setenv("JWT_SECRET", "test_jwt_secret_long_enough_for_hs256")
    monkeypatch.setenv("OWNER_USER_IDS", "777")
    monkeypatch.setenv("OPERATOR_USER_IDS", "888")
    monkeypatch.setenv("ALLOWED_USER_IDS", "")
    monkeypatch.setenv("MINIAPP_SOFT_LAUNCH_OWNER_ONLY", "1")
    monkeypatch.setenv("MINIAPP_SOFT_LAUNCH_OPERATOR_USER_IDS", "")

    get_settings.cache_clear()
    asyncio.run(dispose_engine())
    app = create_app()
    with TestClient(app) as client:
        owner_token = _auth(client, bot_token=bot_token, user_id=777, first_name="Owner")
        assert owner_token

        init_data = _build_init_data(bot_token=bot_token, user_id=888, first_name="Operator")
        blocked = client.post("/api/v1/auth/telegram", json={"initData": init_data})
        assert blocked.status_code == 403
        assert blocked.json()["detail"] == "Soft launch mode: owner-only access"

    asyncio.run(dispose_engine())
    get_settings.cache_clear()


def test_soft_launch_owner_only_allows_whitelisted_operator(tmp_path, monkeypatch):
    db_path = tmp_path / "miniapp_owner_only_allow_operator.db"
    docs_dir = tmp_path / "miniapp_owner_only_allow_operator_docs"
    bot_token = "123456:TEST_TOKEN"

    monkeypatch.setenv("MINIAPP_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setenv("MINIAPP_DOCUMENTS_DIR", str(docs_dir))
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", bot_token)
    monkeypatch.setenv("JWT_SECRET", "test_jwt_secret_long_enough_for_hs256")
    monkeypatch.setenv("OWNER_USER_IDS", "777")
    monkeypatch.setenv("OPERATOR_USER_IDS", "888")
    monkeypatch.setenv("ALLOWED_USER_IDS", "")
    monkeypatch.setenv("MINIAPP_SOFT_LAUNCH_OWNER_ONLY", "1")
    monkeypatch.setenv("MINIAPP_SOFT_LAUNCH_OPERATOR_USER_IDS", "888")

    get_settings.cache_clear()
    asyncio.run(dispose_engine())
    app = create_app()
    with TestClient(app) as client:
        owner_token = _auth(client, bot_token=bot_token, user_id=777, first_name="Owner")
        assert owner_token

        operator_token = _auth(client, bot_token=bot_token, user_id=888, first_name="Operator")
        assert operator_token

    asyncio.run(dispose_engine())
    get_settings.cache_clear()


def test_rate_limit_auth_endpoint(tmp_path, monkeypatch):
    db_path = tmp_path / "miniapp_rate_limit_auth.db"
    docs_dir = tmp_path / "miniapp_rate_limit_auth_docs"
    bot_token = "123456:TEST_TOKEN"

    monkeypatch.setenv("MINIAPP_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setenv("MINIAPP_DOCUMENTS_DIR", str(docs_dir))
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", bot_token)
    monkeypatch.setenv("JWT_SECRET", "test_jwt_secret_long_enough_for_hs256")
    monkeypatch.setenv("OWNER_USER_IDS", "777")
    monkeypatch.setenv("OPERATOR_USER_IDS", "")
    monkeypatch.setenv("ALLOWED_USER_IDS", "")
    monkeypatch.setenv("MINIAPP_SOFT_LAUNCH_OWNER_ONLY", "0")
    monkeypatch.setenv("MINIAPP_RATE_LIMIT_ENABLED", "1")
    monkeypatch.setenv("MINIAPP_RATE_LIMIT_WINDOW_SECONDS", "60")
    monkeypatch.setenv("MINIAPP_RATE_LIMIT_AUTH_PER_WINDOW", "2")
    monkeypatch.setenv("MINIAPP_RATE_LIMIT_WRITE_PER_WINDOW", "1000")
    monkeypatch.setenv("MINIAPP_RATE_LIMIT_GENERAL_PER_WINDOW", "1000")

    get_settings.cache_clear()
    asyncio.run(dispose_engine())
    app = create_app()
    with TestClient(app) as client:
        init_data = _build_init_data(bot_token=bot_token, user_id=777, first_name="Owner")

        first = client.post("/api/v1/auth/telegram", json={"initData": init_data})
        second = client.post("/api/v1/auth/telegram", json={"initData": init_data})
        third = client.post("/api/v1/auth/telegram", json={"initData": init_data})

        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        assert third.status_code == 429, third.text
        assert third.json()["detail"] == "Too many requests"
        assert int(third.headers.get("retry-after") or 0) >= 1

    asyncio.run(dispose_engine())
    get_settings.cache_clear()


_BASE_OP = {
    "operation_type": "расход",
    "payment_account": "ИП Каменский АБ",
    "expense_category": "Офис",
    "date": "2026-04-22",
}


def test_operation_receipt_upload_and_download(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    op = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={**_BASE_OP, "description": "Офис", "amount": 500},
    )
    assert op.status_code == 200, op.text
    op_id = op.json()["id"]
    assert op.json()["has_receipt"] is False

    upload = miniapp_test_client.post(
        f"/api/v1/operations/{op_id}/receipt",
        headers=headers,
        files={"file": ("bill.jpg", io.BytesIO(b"\xff\xd8\xff fake-jpg"), "image/jpeg")},
    )
    assert upload.status_code == 200, upload.text
    doc = upload.json()
    assert doc["operation_id"] == op_id
    assert doc["doc_kind"] == "receipt"
    assert doc["order_id"] is None

    download = miniapp_test_client.get(f"/api/v1/operations/{op_id}/receipt", headers=headers)
    assert download.status_code == 200, download.text
    assert download.content == b"\xff\xd8\xff fake-jpg"


def test_operation_receipt_dedup(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    op = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={**_BASE_OP, "description": "Dedup", "amount": 100},
    )
    assert op.status_code == 200, op.text
    op_id = op.json()["id"]

    content = b"%PDF-1.4 receipt-content"
    first = miniapp_test_client.post(
        f"/api/v1/operations/{op_id}/receipt",
        headers=headers,
        files={"file": ("r.pdf", io.BytesIO(content), "application/pdf")},
    )
    assert first.status_code == 200, first.text

    second = miniapp_test_client.post(
        f"/api/v1/operations/{op_id}/receipt",
        headers=headers,
        files={"file": ("r-copy.pdf", io.BytesIO(content), "application/pdf")},
    )
    assert second.status_code == 200, second.text
    assert second.json()["id"] == first.json()["id"]


def test_operation_receipt_delete(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    op = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={**_BASE_OP, "description": "Удалить чек", "amount": 200},
    )
    assert op.status_code == 200, op.text
    op_id = op.json()["id"]

    miniapp_test_client.post(
        f"/api/v1/operations/{op_id}/receipt",
        headers=headers,
        files={"file": ("r.pdf", io.BytesIO(b"%PDF-1.4 del"), "application/pdf")},
    )

    delete = miniapp_test_client.delete(f"/api/v1/operations/{op_id}/receipt", headers=headers)
    assert delete.status_code == 204, delete.text

    download = miniapp_test_client.get(f"/api/v1/operations/{op_id}/receipt", headers=headers)
    assert download.status_code == 404, download.text


def test_operation_has_receipt_flag_in_list(miniapp_test_client):
    token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    headers = {"Authorization": f"Bearer {token}"}

    op = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=headers,
        json={**_BASE_OP, "description": "Флаг", "amount": 300},
    )
    assert op.status_code == 200, op.text
    op_id = op.json()["id"]

    ops_before = miniapp_test_client.get("/api/v1/operations", headers=headers)
    item_before = next(x for x in ops_before.json() if x["id"] == op_id)
    assert item_before["has_receipt"] is False
    assert item_before["receipt_document_id"] is None

    upload = miniapp_test_client.post(
        f"/api/v1/operations/{op_id}/receipt",
        headers=headers,
        files={"file": ("r.png", io.BytesIO(b"\x89PNG fake"), "image/png")},
    )
    assert upload.status_code == 200, upload.text
    doc_id = upload.json()["id"]

    ops_after = miniapp_test_client.get("/api/v1/operations", headers=headers)
    item_after = next(x for x in ops_after.json() if x["id"] == op_id)
    assert item_after["has_receipt"] is True
    assert item_after["receipt_document_id"] == doc_id


def test_operation_receipt_owner_can_access_operator_receipt(miniapp_test_client):
    owner_token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=777, first_name="Owner")
    op_token = _auth(miniapp_test_client, bot_token="123456:TEST_TOKEN", user_id=888, first_name="Operator")

    owner_headers = {"Authorization": f"Bearer {owner_token}"}
    op_headers = {"Authorization": f"Bearer {op_token}"}

    op = miniapp_test_client.post(
        "/api/v1/operations/manual",
        headers=op_headers,
        json={**_BASE_OP, "description": "Чужой чек", "amount": 150},
    )
    assert op.status_code == 200, op.text
    op_id = op.json()["id"]

    upload = miniapp_test_client.post(
        f"/api/v1/operations/{op_id}/receipt",
        headers=owner_headers,
        files={"file": ("r.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")},
    )
    assert upload.status_code == 200, upload.text

    download = miniapp_test_client.get(f"/api/v1/operations/{op_id}/receipt", headers=op_headers)
    assert download.status_code == 200, download.text
