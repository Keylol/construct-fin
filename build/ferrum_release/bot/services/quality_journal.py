"""Append-only journal for recognition quality events."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime

import config

QUALITY_JOURNAL_PATH = config.DATA_DIR / "recognition_quality.ndjson"


def _append_line(payload: dict):
    QUALITY_JOURNAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(QUALITY_JOURNAL_PATH, "a", encoding="utf-8") as file_obj:
        file_obj.write(json.dumps(payload, ensure_ascii=False) + "\n")


async def append_quality_journal_entry(
    *,
    source_text: str,
    created_by: str,
    status: str,
    parser_mode: str = "unknown",
    parsed_payload: str | None = None,
    final_payload: str | None = None,
    correction_text: str | None = None,
):
    """Appends one quality event into local NDJSON journal."""
    payload = {
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source_text": source_text,
        "created_by": created_by,
        "status": status,
        "parser_mode": parser_mode,
        "parsed_payload": parsed_payload,
        "final_payload": final_payload,
        "correction_text": correction_text,
    }
    await asyncio.to_thread(_append_line, payload)
