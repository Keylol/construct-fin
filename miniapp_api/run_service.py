"""Production-style service entrypoint for launchd."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import uvicorn


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PYTHON_BIN = PROJECT_ROOT / ".venv" / "bin" / "python"
ALEMBIC_BIN = PROJECT_ROOT / ".venv" / "bin" / "alembic"
ALEMBIC_CONFIG = PROJECT_ROOT / "miniapp_api" / "alembic.ini"
DB_PREPARE_SCRIPT = PROJECT_ROOT / "scripts" / "prepare_miniapp_db.py"


def _run_migrations() -> None:
    """Runs legacy-safe migration bootstrap before API startup."""

    action_raw = subprocess.check_output(
        [str(PYTHON_BIN), str(DB_PREPARE_SCRIPT)],
        cwd=str(PROJECT_ROOT),
        text=True,
    ).strip()
    action = action_raw.splitlines()[-1] if action_raw else "UPGRADE_HEAD"

    if action.startswith("STAMP_"):
        revision = action.replace("STAMP_", "", 1) or "head"
        subprocess.check_call(
            [str(ALEMBIC_BIN), "-c", str(ALEMBIC_CONFIG), "stamp", revision],
            cwd=str(PROJECT_ROOT),
        )

    subprocess.check_call(
        [str(ALEMBIC_BIN), "-c", str(ALEMBIC_CONFIG), "upgrade", "head"],
        cwd=str(PROJECT_ROOT),
    )


def main() -> int:
    if os.getenv("MINIAPP_APPLY_MIGRATIONS", "1") == "1":
        _run_migrations()

    host = os.getenv("MINIAPP_API_HOST", "0.0.0.0")
    port = int(os.getenv("MINIAPP_API_PORT", "8080"))
    reload_enabled = os.getenv("MINIAPP_RELOAD", "0") == "1"

    uvicorn.run("miniapp_api.app.main:app", host=host, port=port, reload=reload_enabled)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
