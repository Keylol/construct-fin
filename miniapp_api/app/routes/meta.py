"""Metadata/options routes for Mini App forms."""

from __future__ import annotations

from fastapi import APIRouter, Depends

import config as legacy_config
from miniapp_api.app.deps import require_roles
from miniapp_api.app.models import AppUser
from miniapp_api.app.schemas import MiniAppOptionsDTO


router = APIRouter(prefix="/meta", tags=["meta"])


@router.get("/options", response_model=MiniAppOptionsDTO)
async def get_options(_: AppUser = Depends(require_roles("owner", "operator"))) -> MiniAppOptionsDTO:
    """Returns reference dictionaries for Mini App form controls."""

    return MiniAppOptionsDTO(
        operation_types=list(legacy_config.OPERATION_TYPES),
        income_operation_types=["продажа", "предоплата", "постоплата"],
        expense_categories=list(legacy_config.MINIAPP_BUSINESS_EXPENSE_CATEGORIES),
        expense_subcategories={},
        payment_accounts=list(legacy_config.DEFAULT_PAYMENT_ACCOUNTS),
        payment_methods=list(legacy_config.PAYMENT_METHODS),
        income_channels=list(legacy_config.INCOME_CHANNELS),
        sale_types=list(legacy_config.SALE_TYPES),
        suppliers=list(legacy_config.SUPPLIERS),
        document_types=list(legacy_config.DOCUMENT_TYPES),
        supported_document_extensions=sorted(list(legacy_config.SUPPORTED_DOCUMENT_EXTENSIONS)),
    )
