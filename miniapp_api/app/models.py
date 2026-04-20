"""ORM models for Mini App API."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from miniapp_api.app.db import Base


def _enum_values(enum_cls) -> list[str]:
    return [member.value for member in enum_cls]


class UserRole(StrEnum):
    """Supported user roles."""

    owner = "owner"
    operator = "operator"
    OWNER = owner
    OPERATOR = operator


class OrderStatus(StrEnum):
    """Order statuses for Mini App cards."""

    open = "open"
    closed = "closed"
    OPEN = open
    CLOSED = closed


class AppUser(Base):
    """Telegram-authenticated Mini App user."""

    __tablename__ = "miniapp_users"
    __table_args__ = (UniqueConstraint("telegram_user_id", name="uq_miniapp_users_telegram_user_id"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    telegram_user_id: Mapped[int] = mapped_column(index=True)
    first_name: Mapped[str] = mapped_column(String(128))
    last_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    username: Mapped[str | None] = mapped_column(String(128), nullable=True)
    language_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    role: Mapped[UserRole] = mapped_column(
        Enum(
            UserRole,
            name="userrole",
            values_callable=_enum_values,
            validate_strings=True,
        ),
        default=UserRole.OPERATOR,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        server_default=func.now(),
        onupdate=func.now(),
    )

    orders: Mapped[list["MiniOrder"]] = relationship(back_populates="opened_by", lazy="selectin")


class MiniOrder(Base):
    """Lightweight order record for first Mini App iteration."""

    __tablename__ = "miniapp_orders"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    order_phone: Mapped[str] = mapped_column(String(32), index=True)
    client_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[OrderStatus] = mapped_column(
        Enum(
            OrderStatus,
            name="orderstatus",
            values_callable=_enum_values,
            validate_strings=True,
        ),
        default=OrderStatus.OPEN,
        index=True,
    )
    opened_by_user_id: Mapped[int] = mapped_column(ForeignKey("miniapp_users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        server_default=func.now(),
        onupdate=func.now(),
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True, index=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(nullable=True)

    opened_by: Mapped[AppUser] = relationship(back_populates="orders", lazy="joined")


class MiniOperation(Base):
    """Order-related or standalone financial operation for Mini App."""

    __tablename__ = "miniapp_operations"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    operation_type: Mapped[str] = mapped_column(String(32), index=True)
    description: Mapped[str] = mapped_column(String(1024))
    amount: Mapped[float]
    supplier: Mapped[str | None] = mapped_column(String(255), nullable=True)
    expense_category: Mapped[str | None] = mapped_column(String(255), nullable=True)
    expense_subcategory: Mapped[str | None] = mapped_column(String(255), nullable=True)
    payment_account: Mapped[str | None] = mapped_column(String(128), nullable=True)
    payment_method: Mapped[str | None] = mapped_column(String(64), nullable=True)
    income_channel: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sale_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("miniapp_orders.id"), nullable=True, index=True)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("miniapp_users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True, index=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(nullable=True)


class MiniDocument(Base):
    """Uploaded document bound to Mini App order."""

    __tablename__ = "miniapp_documents"
    __table_args__ = (
        UniqueConstraint("order_id", "file_hash", name="uq_miniapp_documents_order_file_hash"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("miniapp_orders.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(64), default="другое")
    file_name: Mapped[str] = mapped_column(String(255))
    file_path: Mapped[str] = mapped_column(String(1024))
    file_hash: Mapped[str] = mapped_column(String(128), index=True)
    uploaded_by_user_id: Mapped[int] = mapped_column(ForeignKey("miniapp_users.id"), index=True)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), server_default=func.now(), index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True, index=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(nullable=True)


class MiniAuditLog(Base):
    """Audit trail for critical Mini App actions."""

    __tablename__ = "miniapp_audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    actor_user_id: Mapped[int] = mapped_column(index=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str] = mapped_column(String(64), index=True)
    entity_id: Mapped[int | None] = mapped_column(nullable=True, index=True)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), server_default=func.now(), index=True)
