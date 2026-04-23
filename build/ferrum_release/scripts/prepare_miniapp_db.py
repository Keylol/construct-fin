#!/usr/bin/env python3
"""Checks Mini App DB state before Alembic migration run."""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from miniapp_api.app.config import get_settings


TARGET_TABLES = {"miniapp_users", "miniapp_orders", "miniapp_operations"}
LEGACY_BASE_REVISION = "20260413_000001"


async def _read_state() -> tuple[set[str], bool]:
    settings = get_settings()
    engine = create_async_engine(settings.miniapp_database_url, future=True)
    try:
        async with engine.connect() as connection:
            def _load_state(sync_conn):
                tables = set(inspect(sync_conn).get_table_names())
                has_version_row = False
                if "alembic_version" in tables:
                    version = sync_conn.execute(text("SELECT version_num FROM alembic_version LIMIT 1")).scalar()
                    has_version_row = bool(version)
                return tables, has_version_row

            return await connection.run_sync(_load_state)
    finally:
        await engine.dispose()


def main() -> int:
    tables, has_version_row = asyncio.run(_read_state())
    if TARGET_TABLES.intersection(tables) and not has_version_row:
        print(f"STAMP_{LEGACY_BASE_REVISION}")
        return 0
    print("UPGRADE_HEAD")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
