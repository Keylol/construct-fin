"""add miniapp documents table

Revision ID: 20260413_000002
Revises: 20260413_000001
Create Date: 2026-04-13 02:20:00
"""

from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260413_000002"
down_revision: str | Sequence[str] | None = "20260413_000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "miniapp_documents" in set(inspector.get_table_names()):
        return

    op.create_table(
        "miniapp_documents",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("order_id", sa.Integer(), nullable=False),
        sa.Column("doc_type", sa.String(length=64), nullable=False, server_default=sa.text("'другое'")),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("file_path", sa.String(length=1024), nullable=False),
        sa.Column("file_hash", sa.String(length=128), nullable=False),
        sa.Column("uploaded_by_user_id", sa.Integer(), nullable=False),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=False),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["order_id"], ["miniapp_orders.id"]),
        sa.ForeignKeyConstraint(["uploaded_by_user_id"], ["miniapp_users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("order_id", "file_hash", name="uq_miniapp_documents_order_file_hash"),
    )
    op.create_index("ix_miniapp_documents_file_hash", "miniapp_documents", ["file_hash"], unique=False)
    op.create_index("ix_miniapp_documents_order_id", "miniapp_documents", ["order_id"], unique=False)
    op.create_index(
        "ix_miniapp_documents_uploaded_by_user_id",
        "miniapp_documents",
        ["uploaded_by_user_id"],
        unique=False,
    )
    op.create_index("ix_miniapp_documents_uploaded_at", "miniapp_documents", ["uploaded_at"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "miniapp_documents" not in set(inspector.get_table_names()):
        return

    op.drop_index("ix_miniapp_documents_uploaded_at", table_name="miniapp_documents")
    op.drop_index("ix_miniapp_documents_uploaded_by_user_id", table_name="miniapp_documents")
    op.drop_index("ix_miniapp_documents_order_id", table_name="miniapp_documents")
    op.drop_index("ix_miniapp_documents_file_hash", table_name="miniapp_documents")
    op.drop_table("miniapp_documents")
