"""init miniapp schema

Revision ID: 20260413_000001
Revises:
Create Date: 2026-04-13 00:50:00
"""

from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260413_000001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    user_role = sa.Enum("owner", "operator", name="userrole")
    order_status = sa.Enum("open", "closed", name="orderstatus")

    op.create_table(
        "miniapp_users",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("telegram_user_id", sa.Integer(), nullable=False),
        sa.Column("first_name", sa.String(length=128), nullable=False),
        sa.Column("last_name", sa.String(length=128), nullable=True),
        sa.Column("username", sa.String(length=128), nullable=True),
        sa.Column("language_code", sa.String(length=16), nullable=True),
        sa.Column(
            "role",
            user_role,
            nullable=False,
            server_default=sa.text("'operator'"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=False),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=False),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("telegram_user_id", name="uq_miniapp_users_telegram_user_id"),
    )
    op.create_index("ix_miniapp_users_telegram_user_id", "miniapp_users", ["telegram_user_id"], unique=False)

    op.create_table(
        "miniapp_orders",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("order_phone", sa.String(length=32), nullable=False),
        sa.Column("client_name", sa.String(length=255), nullable=True),
        sa.Column(
            "status",
            order_status,
            nullable=False,
            server_default=sa.text("'open'"),
        ),
        sa.Column("opened_by_user_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=False),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=False),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["opened_by_user_id"], ["miniapp_users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_miniapp_orders_order_phone", "miniapp_orders", ["order_phone"], unique=False)
    op.create_index("ix_miniapp_orders_opened_by_user_id", "miniapp_orders", ["opened_by_user_id"], unique=False)
    op.create_index("ix_miniapp_orders_status", "miniapp_orders", ["status"], unique=False)

    op.create_table(
        "miniapp_operations",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("date", sa.String(length=16), nullable=False),
        sa.Column("operation_type", sa.String(length=32), nullable=False),
        sa.Column("description", sa.String(length=1024), nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("supplier", sa.String(length=255), nullable=True),
        sa.Column("expense_category", sa.String(length=255), nullable=True),
        sa.Column("expense_subcategory", sa.String(length=255), nullable=True),
        sa.Column("payment_account", sa.String(length=128), nullable=True),
        sa.Column("payment_method", sa.String(length=64), nullable=True),
        sa.Column("income_channel", sa.String(length=64), nullable=True),
        sa.Column("sale_type", sa.String(length=64), nullable=True),
        sa.Column("order_id", sa.Integer(), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=False),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["miniapp_users.id"]),
        sa.ForeignKeyConstraint(["order_id"], ["miniapp_orders.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_miniapp_operations_created_by_user_id", "miniapp_operations", ["created_by_user_id"], unique=False)
    op.create_index("ix_miniapp_operations_date", "miniapp_operations", ["date"], unique=False)
    op.create_index("ix_miniapp_operations_operation_type", "miniapp_operations", ["operation_type"], unique=False)
    op.create_index("ix_miniapp_operations_order_id", "miniapp_operations", ["order_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_miniapp_operations_order_id", table_name="miniapp_operations")
    op.drop_index("ix_miniapp_operations_operation_type", table_name="miniapp_operations")
    op.drop_index("ix_miniapp_operations_date", table_name="miniapp_operations")
    op.drop_index("ix_miniapp_operations_created_by_user_id", table_name="miniapp_operations")
    op.drop_table("miniapp_operations")

    op.drop_index("ix_miniapp_orders_status", table_name="miniapp_orders")
    op.drop_index("ix_miniapp_orders_opened_by_user_id", table_name="miniapp_orders")
    op.drop_index("ix_miniapp_orders_order_phone", table_name="miniapp_orders")
    op.drop_table("miniapp_orders")

    op.drop_index("ix_miniapp_users_telegram_user_id", table_name="miniapp_users")
    op.drop_table("miniapp_users")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("DROP TYPE IF EXISTS orderstatus")
        op.execute("DROP TYPE IF EXISTS userrole")
