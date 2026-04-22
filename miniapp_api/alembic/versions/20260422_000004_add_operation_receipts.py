"""add operation_id and doc_kind to documents, make order_id nullable

Revision ID: 20260422_000004
Revises: 20260418_000003
Create Date: 2026-04-22 12:00:00
"""

from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260422_000004"
down_revision: str | Sequence[str] | None = "20260418_000003"
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
    if "miniapp_documents" not in tables:
        return

    _add_column_if_missing(
        "miniapp_documents",
        sa.Column("operation_id", sa.Integer(), nullable=True),
    )
    _add_column_if_missing(
        "miniapp_documents",
        sa.Column("doc_kind", sa.String(length=32), nullable=False, server_default="client"),
    )
    _create_index_if_missing("ix_miniapp_documents_operation_id", "miniapp_documents", ["operation_id"])
    _create_index_if_missing("ix_miniapp_documents_doc_kind", "miniapp_documents", ["doc_kind"])

    # Relax order_id nullability so receipts for standalone operations can be stored.
    # Postgres supports ALTER COLUMN DROP NOT NULL; SQLite needs batch_alter_table.
    dialect_name = bind.dialect.name
    order_id_col_info = next(
        (col for col in inspector.get_columns("miniapp_documents") if col["name"] == "order_id"),
        None,
    )
    if order_id_col_info and not order_id_col_info.get("nullable", True):
        if dialect_name == "sqlite":
            with op.batch_alter_table("miniapp_documents") as batch_op:
                batch_op.alter_column("order_id", existing_type=sa.Integer(), nullable=True)
        else:
            op.alter_column(
                "miniapp_documents",
                "order_id",
                existing_type=sa.Integer(),
                nullable=True,
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "miniapp_documents" not in tables:
        return

    existing_indexes = {item["name"] for item in inspector.get_indexes("miniapp_documents")}
    for index_name in ("ix_miniapp_documents_doc_kind", "ix_miniapp_documents_operation_id"):
        if index_name in existing_indexes:
            op.drop_index(index_name, table_name="miniapp_documents")

    # Column drops on SQLite are intentionally omitted.
    if bind.dialect.name != "sqlite":
        for column_name in ("doc_kind", "operation_id"):
            if _has_column(inspector, "miniapp_documents", column_name):
                op.drop_column("miniapp_documents", column_name)
