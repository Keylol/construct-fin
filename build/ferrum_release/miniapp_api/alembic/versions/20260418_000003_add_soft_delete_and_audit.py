"""add soft delete columns and miniapp audit log

Revision ID: 20260418_000003
Revises: 20260413_000002
Create Date: 2026-04-18 10:20:00
"""

from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260418_000003"
down_revision: str | Sequence[str] | None = "20260413_000002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return column_name in {column["name"] for column in inspector.get_columns(table_name)}


def _add_column_if_missing(table_name: str, column: sa.Column) -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in set(inspector.get_table_names()):
        return
    if _has_column(inspector, table_name, column.name):
        return
    op.add_column(table_name, column)


def _create_index_if_missing(index_name: str, table_name: str, columns: list[str]) -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {item["name"] for item in inspector.get_indexes(table_name)}
    if index_name in existing:
        return
    op.create_index(index_name, table_name, columns, unique=False)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    _add_column_if_missing("miniapp_orders", sa.Column("deleted_at", sa.DateTime(timezone=False), nullable=True))
    _add_column_if_missing("miniapp_orders", sa.Column("deleted_by_user_id", sa.Integer(), nullable=True))
    _create_index_if_missing("ix_miniapp_orders_deleted_at", "miniapp_orders", ["deleted_at"])

    _add_column_if_missing("miniapp_operations", sa.Column("deleted_at", sa.DateTime(timezone=False), nullable=True))
    _add_column_if_missing("miniapp_operations", sa.Column("deleted_by_user_id", sa.Integer(), nullable=True))
    _create_index_if_missing("ix_miniapp_operations_deleted_at", "miniapp_operations", ["deleted_at"])

    _add_column_if_missing("miniapp_documents", sa.Column("deleted_at", sa.DateTime(timezone=False), nullable=True))
    _add_column_if_missing("miniapp_documents", sa.Column("deleted_by_user_id", sa.Integer(), nullable=True))
    _create_index_if_missing("ix_miniapp_documents_deleted_at", "miniapp_documents", ["deleted_at"])

    if "miniapp_audit_logs" not in tables:
        op.create_table(
            "miniapp_audit_logs",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("actor_user_id", sa.Integer(), nullable=False),
            sa.Column("action", sa.String(length=64), nullable=False),
            sa.Column("entity_type", sa.String(length=64), nullable=False),
            sa.Column("entity_id", sa.Integer(), nullable=True),
            sa.Column("details", sa.JSON(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=False),
                server_default=sa.text("CURRENT_TIMESTAMP"),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_index_if_missing("ix_miniapp_audit_logs_actor_user_id", "miniapp_audit_logs", ["actor_user_id"])
    _create_index_if_missing("ix_miniapp_audit_logs_action", "miniapp_audit_logs", ["action"])
    _create_index_if_missing("ix_miniapp_audit_logs_entity_type", "miniapp_audit_logs", ["entity_type"])
    _create_index_if_missing("ix_miniapp_audit_logs_entity_id", "miniapp_audit_logs", ["entity_id"])
    _create_index_if_missing("ix_miniapp_audit_logs_created_at", "miniapp_audit_logs", ["created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "miniapp_audit_logs" in tables:
        for index_name in (
            "ix_miniapp_audit_logs_created_at",
            "ix_miniapp_audit_logs_entity_id",
            "ix_miniapp_audit_logs_entity_type",
            "ix_miniapp_audit_logs_action",
            "ix_miniapp_audit_logs_actor_user_id",
        ):
            existing = {item["name"] for item in sa.inspect(bind).get_indexes("miniapp_audit_logs")}
            if index_name in existing:
                op.drop_index(index_name, table_name="miniapp_audit_logs")
        op.drop_table("miniapp_audit_logs")

    for table_name, index_name in (
        ("miniapp_documents", "ix_miniapp_documents_deleted_at"),
        ("miniapp_operations", "ix_miniapp_operations_deleted_at"),
        ("miniapp_orders", "ix_miniapp_orders_deleted_at"),
    ):
        if table_name not in set(sa.inspect(bind).get_table_names()):
            continue
        existing_indexes = {item["name"] for item in sa.inspect(bind).get_indexes(table_name)}
        if index_name in existing_indexes:
            op.drop_index(index_name, table_name=table_name)

    # SQLite downgrade of dropping columns is intentionally omitted.
