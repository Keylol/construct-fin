"""Pydantic schemas for API requests and responses."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator


class HealthResponse(BaseModel):
    status: str = "ok"


class TelegramAuthRequest(BaseModel):
    init_data: str = Field(min_length=8)

    @model_validator(mode="before")
    @classmethod
    def _normalize_payload(cls, raw: object) -> object:
        if isinstance(raw, dict) and "initData" in raw and "init_data" not in raw:
            normalized = dict(raw)
            normalized["init_data"] = normalized["initData"]
            return normalized
        return raw


class UserDTO(BaseModel):
    id: int
    telegram_user_id: int
    first_name: str
    last_name: str | None = None
    username: str | None = None
    language_code: str | None = None
    role: str

    model_config = ConfigDict(from_attributes=True)


class TelegramAuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserDTO


class OrderCreateRequest(BaseModel):
    order_phone: str = Field(min_length=7, max_length=32)
    client_name: str | None = Field(default=None, max_length=255)


class OrderUpdateRequest(BaseModel):
    order_phone: str | None = Field(default=None, min_length=7, max_length=32)
    client_name: str | None = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def _ensure_any_value(self) -> "OrderUpdateRequest":
        if self.order_phone is None and self.client_name is None:
            raise ValueError("At least one field must be provided")
        return self


class OrderDTO(BaseModel):
    id: int
    order_phone: str
    client_name: str | None = None
    status: str
    opened_by_user_id: int
    sale_amount: float = 0.0
    paid_amount: float = 0.0
    prepayment_amount: float = 0.0
    postpayment_amount: float = 0.0
    payment_receipt_amount: float = 0.0
    purchase_cost: float = 0.0
    recognized_cogs: float = 0.0
    balance_due: float = 0.0
    documents_count: int = 0
    has_changes: bool = False
    last_activity_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class OperationManualCreateRequest(BaseModel):
    operation_type: str = Field(min_length=3, max_length=32)
    description: str = Field(min_length=2, max_length=1024)
    amount: float
    date: str | None = Field(default=None, max_length=16)
    order_id: int | None = None
    supplier: str | None = Field(default=None, max_length=255)
    expense_category: str | None = Field(default=None, max_length=255)
    expense_subcategory: str | None = Field(default=None, max_length=255)
    payment_account: str | None = Field(default=None, max_length=128)
    payment_method: str | None = Field(default=None, max_length=64)
    income_channel: str | None = Field(default=None, max_length=64)
    sale_type: str | None = Field(default=None, max_length=64)


class OperationTextCreateRequest(BaseModel):
    text: str = Field(min_length=4, max_length=4096)
    order_id: int | None = None


class OperationManualPreviewRequest(BaseModel):
    operation_type: str | None = Field(default=None, max_length=32)
    description: str | None = Field(default=None, max_length=1024)
    amount: float | None = None
    date: str | None = Field(default=None, max_length=16)
    order_id: int | None = None
    supplier: str | None = Field(default=None, max_length=255)
    expense_category: str | None = Field(default=None, max_length=255)
    expense_subcategory: str | None = Field(default=None, max_length=255)
    payment_account: str | None = Field(default=None, max_length=128)
    payment_method: str | None = Field(default=None, max_length=64)
    income_channel: str | None = Field(default=None, max_length=64)
    sale_type: str | None = Field(default=None, max_length=64)


class OperationDTO(BaseModel):
    id: int
    date: str
    operation_type: str
    description: str
    amount: float
    supplier: str | None = None
    expense_category: str | None = None
    expense_subcategory: str | None = None
    payment_account: str | None = None
    payment_method: str | None = None
    income_channel: str | None = None
    sale_type: str | None = None
    order_id: int | None = None
    created_by_user_id: int
    created_at: datetime
    has_receipt: bool = False
    receipt_document_id: int | None = None

    model_config = ConfigDict(from_attributes=True)


class OperationPreviewResponse(BaseModel):
    operation: OperationManualPreviewRequest
    ready_to_save: bool
    missing_fields: list[str]


class MiniAppOptionsDTO(BaseModel):
    operation_types: list[str]
    income_operation_types: list[str]
    expense_categories: list[str]
    expense_subcategories: dict[str, list[str]]
    payment_accounts: list[str]
    payment_methods: list[str]
    income_channels: list[str]
    sale_types: list[str]
    suppliers: list[str]
    document_types: list[str]
    supported_document_extensions: list[str]


class ReportSummaryDTO(BaseModel):
    period_start: str
    period_end: str
    days: int
    income: float
    average_ticket: float
    cash_received: float
    purchases: float
    other_expenses: float
    commercial_expenses: float
    payroll_expenses: float
    contractor_expenses: float
    non_operating_expenses: float
    total_expenses: float
    profit: float
    operations_count: int
    open_orders_count: int
    open_orders_revenue: float
    open_orders_paid: float
    open_orders_balance_due: float
    wip_amount: float


class ReportPointDTO(BaseModel):
    date: str
    income: float
    cash_received: float
    expenses: float
    profit: float


class DocumentDTO(BaseModel):
    id: int
    order_id: int | None = None
    operation_id: int | None = None
    doc_kind: str = "client"
    doc_type: str
    file_name: str
    file_path: str
    file_hash: str
    uploaded_by_user_id: int
    uploaded_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DocumentAssistItemDTO(BaseModel):
    component_name: str
    component_value: str
    confidence: float | None = None


class DocumentAssistResponse(BaseModel):
    document_id: int
    mode: str
    title: str
    summary: str
    highlights: list[str] = Field(default_factory=list)
    suggested_actions: list[str] = Field(default_factory=list)
    items_preview: list[str] = Field(default_factory=list)
    parsed_items: list[DocumentAssistItemDTO] = Field(default_factory=list)
    customer_total: float | None = None
    customer_name: str | None = None
    order_phone: str | None = None
    confidence: float | None = None


class AuditLogDTO(BaseModel):
    id: int
    actor_user_id: int
    action: str
    entity_type: str
    entity_id: int | None = None
    details: dict | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class GoogleSheetsSyncResponse(BaseModel):
    spreadsheet_id: str
    spreadsheet_url: str
    created: bool
    months: list[str]
    operations_exported: int
    review_items: int


class AiModelStateResponse(BaseModel):
    active_model: str
    available_models: list[str]
    updated_at: str | None = None


class AiModelUpdateRequest(BaseModel):
    model: str = Field(min_length=2, max_length=128)
