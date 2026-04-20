"""Runtime AI model switching shared by bot and Mini App."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import config


def get_available_ai_models() -> list[str]:
    values = [str(item).strip() for item in config.AI_MODEL_OPTIONS if str(item).strip()]
    return list(dict.fromkeys(values))


def _runtime_path() -> Path:
    path = Path(config.AI_RUNTIME_STATE_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def read_ai_runtime_state() -> dict:
    path = _runtime_path()
    if not path.exists():
        return {"active_model": config.AI_MODEL, "updated_at": None}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {"active_model": config.AI_MODEL, "updated_at": None}
    active_model = str(payload.get("active_model") or "").strip()
    if active_model not in get_available_ai_models():
        active_model = config.AI_MODEL
    return {
        "active_model": active_model,
        "updated_at": payload.get("updated_at"),
    }


def get_active_ai_model() -> str:
    return str(read_ai_runtime_state().get("active_model") or config.AI_MODEL)


def set_active_ai_model(model: str) -> dict:
    normalized = str(model or "").strip()
    if normalized not in get_available_ai_models():
        raise ValueError(f"Unsupported AI model: {normalized}")
    payload = {
        "active_model": normalized,
        "updated_at": datetime.now(tz=UTC).isoformat(),
    }
    _runtime_path().write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload
