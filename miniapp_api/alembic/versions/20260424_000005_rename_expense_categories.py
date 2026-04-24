"""rename expense categories: Зарплаты→Зарплатный фонд, extract Внешние исполнители from subcategory

Revision ID: 20260424_000005
Revises: 20260422_000004
Create Date: 2026-04-24 12:00:00
"""

from __future__ import annotations

from typing import Sequence

from alembic import op

revision: str = "20260424_000005"
down_revision: str | None = "20260422_000004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. "Зарплаты" subcategory=Подрядчики records → new "Внешние исполнители" category
    op.execute("""
        UPDATE miniapp_operations
        SET expense_category = 'Внешние исполнители',
            expense_subcategory = NULL
        WHERE expense_category = 'Зарплаты'
          AND expense_subcategory = 'Подрядчики'
    """)

    # 2. Rename remaining "Зарплаты" → "Зарплатный фонд"
    op.execute("""
        UPDATE miniapp_operations
        SET expense_category = 'Зарплатный фонд'
        WHERE expense_category = 'Зарплаты'
    """)


def downgrade() -> None:
    op.execute("""
        UPDATE miniapp_operations
        SET expense_category = 'Зарплаты'
        WHERE expense_category = 'Зарплатный фонд'
    """)
    op.execute("""
        UPDATE miniapp_operations
        SET expense_category = 'Зарплаты',
            expense_subcategory = 'Подрядчики'
        WHERE expense_category = 'Внешние исполнители'
    """)
