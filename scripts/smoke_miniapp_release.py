#!/usr/bin/env python3
"""Production-like smoke for running Mini App services."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import random
import string
import time
from datetime import UTC, datetime
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv


def _first_id(raw: str) -> int | None:
    for chunk in str(raw or "").split(","):
        token = chunk.strip()
        if token.isdigit():
            return int(token)
    return None


def _build_init_data(*, bot_token: str, user_id: int, first_name: str) -> str:
    ts = int(datetime.now(tz=UTC).timestamp())
    user = {"id": user_id, "first_name": first_name, "username": f"user_{user_id}", "language_code": "ru"}
    payload = {
        "auth_date": str(ts),
        "query_id": f"SMOKE_{user_id}_{ts}",
        "user": json.dumps(user, ensure_ascii=False, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(payload.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    payload["hash"] = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    return urlencode(payload)


def _rand_phone() -> str:
    tail = "".join(random.choice(string.digits) for _ in range(8))  # noqa: S311
    return f"+79{tail}"


def _check(name: str, fn):
    try:
        fn()
        print(f"[PASS] {name}")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] {name}: {exc}")
        return False


def main() -> int:
    load_dotenv()

    api_base = os.getenv("SMOKE_API_BASE", "http://127.0.0.1:8080/api/v1").rstrip("/")
    public_url = os.getenv("MINIAPP_URL", "").strip()
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    user_id = (
        _first_id(os.getenv("OWNER_USER_IDS", ""))
        or _first_id(os.getenv("ALLOWED_USER_IDS", ""))
        or _first_id(os.getenv("OPERATOR_USER_IDS", ""))
    )

    if not bot_token:
        print("[FAIL] env TELEGRAM_BOT_TOKEN is empty")
        return 2
    if not user_id:
        print("[FAIL] no Telegram user id found in OWNER/ALLOWED/OPERATOR ids")
        return 2

    timeout = httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=30.0)
    token = ""
    order_id = 0

    with httpx.Client(timeout=timeout, trust_env=False) as client:
        checks_ok = []

        def check_health():
            res = client.get("http://127.0.0.1:8080/healthz")
            res.raise_for_status()
            payload = res.json()
            if payload.get("status") != "ok":
                raise RuntimeError(f"unexpected health payload: {payload}")

        checks_ok.append(_check("API health", check_health))

        def check_public_url():
            if not public_url:
                raise RuntimeError("MINIAPP_URL is empty")
            res = client.get(public_url)
            res.raise_for_status()
            if "text/html" not in str(res.headers.get("content-type", "")):
                raise RuntimeError(f"unexpected content-type: {res.headers.get('content-type')}")

        checks_ok.append(_check("Public Mini App URL", check_public_url))

        def check_auth():
            nonlocal token
            init_data = _build_init_data(bot_token=bot_token, user_id=int(user_id), first_name="Smoke")
            res = client.post(f"{api_base}/auth/telegram", json={"initData": init_data})
            res.raise_for_status()
            payload = res.json()
            token = str(payload.get("access_token") or "")
            if not token:
                raise RuntimeError("access_token missing")

        checks_ok.append(_check("Telegram auth", check_auth))

        headers = {"Authorization": f"Bearer {token}"} if token else {}

        def check_options():
            res = client.get(f"{api_base}/meta/options", headers=headers)
            res.raise_for_status()
            payload = res.json()
            if "operation_types" not in payload:
                raise RuntimeError("operation_types missing")

        checks_ok.append(_check("Meta options", check_options))

        def check_order_create():
            nonlocal order_id
            res = client.post(
                f"{api_base}/orders",
                headers=headers,
                json={"order_phone": _rand_phone(), "client_name": "Smoke Flow"},
            )
            res.raise_for_status()
            payload = res.json()
            order_id = int(payload["id"])

        checks_ok.append(_check("Create order", check_order_create))

        def check_purchase_preview_and_save():
            preview_res = client.post(
                f"{api_base}/operations/preview/manual",
                headers=headers,
                json={
                    "operation_type": "закупка",
                    "description": "Smoke purchase",
                    "amount": 4000,
                    "order_id": order_id,
                    "payment_account": "ИП Каменский АБ",
                },
            )
            preview_res.raise_for_status()
            preview = preview_res.json()
            if not preview.get("ready_to_save"):
                raise RuntimeError(f"preview not ready: {preview}")

            save_res = client.post(f"{api_base}/operations/manual", headers=headers, json=preview["operation"])
            save_res.raise_for_status()

        checks_ok.append(_check("Preview + save purchase", check_purchase_preview_and_save))

        def check_reports():
            res = client.get(f"{api_base}/reports/summary?days=7", headers=headers)
            res.raise_for_status()
            payload = res.json()
            if "profit" not in payload:
                raise RuntimeError("profit missing in summary")

            export = client.get(f"{api_base}/reports/export.csv?days=7", headers=headers)
            export.raise_for_status()
            if "text/csv" not in str(export.headers.get("content-type", "")):
                raise RuntimeError("csv content-type missing")

        def check_documents():
            files = {"file": ("smoke.pdf", b"%PDF-1.4 smoke", "application/pdf")}
            data = {"order_id": str(order_id), "doc_type": "чек"}
            upload = client.post(f"{api_base}/documents", headers=headers, files=files, data=data)
            upload.raise_for_status()

            listed = client.get(f"{api_base}/documents?order_id={order_id}", headers=headers)
            listed.raise_for_status()
            docs = listed.json()
            if not docs:
                raise RuntimeError("no uploaded docs found")

        checks_ok.append(_check("Documents upload + list", check_documents))

        def check_finalize_order():
            res = client.post(
                f"{api_base}/orders/{order_id}/finalize",
                headers=headers,
                json={"sale_amount": 12345},
            )
            res.raise_for_status()
            payload = res.json()
            if str(payload.get("status", "")).lower() != "closed":
                raise RuntimeError(f"unexpected status: {payload}")
            expected_amounts = {
                "sale_amount": 12345.0,
                "paid_amount": 12345.0,
                "purchase_cost": 4000.0,
                "recognized_cogs": 4000.0,
                "balance_due": 0.0,
            }
            for key, expected in expected_amounts.items():
                actual = float(payload.get(key) or 0.0)
                if abs(actual - expected) > 0.01:
                    raise RuntimeError(f"unexpected {key}: expected={expected}, actual={actual}, payload={payload}")

        checks_ok.append(_check("Finalize order atomically", check_finalize_order))
        checks_ok.append(_check("Reports summary + export", check_reports))

        time.sleep(0.1)
        if all(checks_ok):
            print("SMOKE_RELEASE_OK")
            return 0
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
