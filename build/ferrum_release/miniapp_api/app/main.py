"""FastAPI entrypoint for Telegram Mini App backend."""

from __future__ import annotations

from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from miniapp_api.app.config import get_settings
from miniapp_api.app.db import Base, get_engine
from miniapp_api.app.middleware.rate_limit import RateLimitPolicy, build_rate_limit_middleware
from miniapp_api.app.routes.admin import router as admin_router
from miniapp_api.app.routes.audit import router as audit_router
from miniapp_api.app.routes.auth import router as auth_router
from miniapp_api.app.routes.documents import router as documents_router
from miniapp_api.app.routes.health import router as health_router
from miniapp_api.app.routes.meta import router as meta_router
from miniapp_api.app.routes.operations import router as operations_router
from miniapp_api.app.routes.orders import router as orders_router
from miniapp_api.app.routes.reports import router as reports_router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Initializes DB schema for first bootstrap."""

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield


def create_app() -> FastAPI:
    """Builds FastAPI application."""

    settings = get_settings()
    app = FastAPI(title="ConstructPC Mini App API", version="0.1.0", lifespan=lifespan)

    if settings.app_env.strip().lower() == "production" and settings.jwt_secret_is_weak:
        raise RuntimeError("JWT_SECRET is weak for production environment")

    if settings.jwt_secret_is_weak:
        logger.warning(
            "JWT_SECRET is weak (<32 chars or default). "
            "Run scripts/harden_jwt_secret.sh and restart com.constructpc.miniapp.api."
        )

    if settings.allowed_ids and settings.has_explicit_miniapp_roles:
        logger.warning(
            "ALLOWED_USER_IDS is ignored by Mini App API because OWNER_USER_IDS/OPERATOR_USER_IDS are configured. "
            "Keep ALLOWED_USER_IDS only for the legacy bot if needed."
        )
    elif settings.uses_legacy_allowed_ids_for_miniapp:
        logger.warning(
            "Mini App API is using legacy ALLOWED_USER_IDS fallback. "
            "Migrate to OWNER_USER_IDS/OPERATOR_USER_IDS for a safer role model."
        )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    if settings.miniapp_rate_limit_enabled:
        app.middleware("http")(
            build_rate_limit_middleware(
                policy=RateLimitPolicy(
                    window_seconds=settings.miniapp_rate_limit_window_seconds,
                    general_limit=settings.miniapp_rate_limit_general_per_window,
                    write_limit=settings.miniapp_rate_limit_write_per_window,
                    auth_limit=settings.miniapp_rate_limit_auth_per_window,
                ),
                api_base_path=settings.api_base_path,
            )
        )

    app.include_router(health_router)
    app.include_router(auth_router, prefix=settings.api_base_path)
    app.include_router(admin_router, prefix=settings.api_base_path)
    app.include_router(audit_router, prefix=settings.api_base_path)
    app.include_router(meta_router, prefix=settings.api_base_path)
    app.include_router(orders_router, prefix=settings.api_base_path)
    app.include_router(operations_router, prefix=settings.api_base_path)
    app.include_router(reports_router, prefix=settings.api_base_path)
    app.include_router(documents_router, prefix=settings.api_base_path)
    return app


app = create_app()
