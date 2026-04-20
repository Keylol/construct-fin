"""Health check endpoints."""

from fastapi import APIRouter

from miniapp_api.app.schemas import HealthResponse


router = APIRouter(tags=["health"])


@router.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    """Liveness endpoint."""

    return HealthResponse()
