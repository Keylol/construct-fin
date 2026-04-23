import pytest_asyncio
from pathlib import Path
from uuid import uuid4
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import config
from bot.services import database


@pytest_asyncio.fixture
async def isolated_db(monkeypatch):
    """Creates isolated sqlite DB for tests."""
    artifacts_dir = Path("data") / "test_artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    db_path = artifacts_dir / f"test_{uuid4().hex}.db"
    if db_path.exists():
        db_path.unlink()
    monkeypatch.setattr(config, "DATABASE_PATH", db_path)
    await database.init_db()
    try:
        yield db_path
    finally:
        if db_path.exists():
            db_path.unlink(missing_ok=True)
