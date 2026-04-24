"""Background Google Sheets sync helpers."""

from __future__ import annotations

import logging

from miniapp_api.app.db import get_session_factory
from miniapp_api.app.services.google_sheets import sync_google_sheets_from_miniapp

logger = logging.getLogger(__name__)


async def sync_sheets_background() -> None:
    """Synchronize Google Sheets without blocking the committed API mutation."""

    try:
        session_factory = get_session_factory()
        async with session_factory() as db:
            await sync_google_sheets_from_miniapp(db)
    except Exception:
        logger.exception("Google Sheets background sync failed")
