"""make operation amount fixed precision

Revision ID: 20260424_000006
Revises: 20260424_000005
Create Date: 2026-04-24 18:00:00
"""

from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260424_000006"
down_revision: str | Sequence[str] | None = "20260424_000005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "miniapp_operations" not in set(inspector.get_table_names()):
        return

    if bind.dialect.name == "sqlite":
        with op.batch_alter_table("miniapp_operations") as batch_op:
            batch_op.alter_column("amount", existing_type=sa.Float(), type_=sa.Numeric(14, 2), nullable=False)
    else:
        op.alter_column(
            "miniapp_operations",
            "amount",
            existing_type=sa.Float(),
            type_=sa.Numeric(14, 2),
            nullable=False,
            postgresql_using="round(amount::numeric, 2)",
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "miniapp_operations" not in set(inspector.get_table_names()):
        return

    if bind.dialect.name == "sqlite":
        with op.batch_alter_table("miniapp_operations") as batch_op:
            batch_op.alter_column("amount", existing_type=sa.Numeric(14, 2), type_=sa.Float(), nullable=False)
    else:
        op.alter_column(
            "miniapp_operations",
            "amount",
            existing_type=sa.Numeric(14, 2),
            type_=sa.Float(),
            nullable=False,
            postgresql_using="amount::double precision",
        )
