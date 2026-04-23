#!/usr/bin/env python3
"""One-time migration: Jon operations and receipt to Ferrum PostgreSQL (v2, fixed SQL placeholders)."""
import asyncio
import base64
import hashlib
import os
import sys
from datetime import datetime
from pathlib import Path

RECEIPT_FILENAME = "чек 22.jpg"
RECEIPT_HASH = "241a2a68ce0079bb1c8af6187a561237c3c910b34d76a7fda71b755304bc5666"
JON_TELEGRAM_ID = 962441603

OPERATIONS = [
    dict(
        date="2026-04-23",
        operation_type="расход",
        description="Оплата IPOS, реклама 120к + НДС, услуги 30к",
        amount=150000.0,
        expense_category="Реклама",
        expense_subcategory="Прочее",
        payment_account="ИП Каменский АБ",
        payment_method="перевод",
        has_receipt=False,
    ),
    dict(
        date="2026-04-22",
        operation_type="расход",
        description="Аванс Кастом Александр",
        amount=5000.0,
        expense_category="Розыгрыши",
        expense_subcategory="Прочее",
        payment_account="ИП Каменский АБ",
        payment_method="перевод",
        has_receipt=True,
    ),
    dict(
        date="2026-04-20",
        operation_type="расход",
        description="Монтажёру",
        amount=4500.0,
        expense_category="Развитие бизнеса",
        expense_subcategory="Прочее",
        payment_account="ИП Каменский АБ",
        payment_method="перевод",
        has_receipt=False,
    ),
]


async def main() -> None:
    from dotenv import load_dotenv
    import asyncpg

    env_path = Path("/srv/construct/app/.env")
    load_dotenv(env_path)
    raw_url = os.getenv("MINIAPP_DATABASE_URL", "")
    dsn = raw_url.replace("postgresql+asyncpg://", "postgresql://")
    docs_dir = Path(os.getenv("MINIAPP_DOCUMENTS_DIR", "/srv/construct/app/data/miniapp_documents"))
    if not docs_dir.is_absolute():
        docs_dir = Path("/srv/construct/app") / str(docs_dir).lstrip("./")

    conn = await asyncpg.connect(dsn)
    try:
        # Find or create Jon user
        jon_id = await conn.fetchval(
            "SELECT id FROM miniapp_users WHERE telegram_user_id = $1",
            JON_TELEGRAM_ID,
        )
        if jon_id is None:
            jon_id = await conn.fetchval(
                """INSERT INTO miniapp_users
                   (telegram_user_id, first_name, username, language_code, role, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, 'owner', NOW(), NOW())
                   RETURNING id""",
                JON_TELEGRAM_ID, "Jon", "Construct_21", "ru",
            )
            print(f"Created user Jon id={jon_id}")
        else:
            print(f"Found existing user Jon id={jon_id}")

        # Skip if already migrated
        existing = await conn.fetchval(
            "SELECT id FROM miniapp_operations WHERE created_by_user_id = $1 AND description = $2",
            jon_id,
            "Оплата IPOS, реклама 120к + НДС, услуги 30к",
        )
        if existing:
            print("Already migrated, skipping.")
            return

        receipt_op_id = None
        for op in OPERATIONS:
            op_id = await conn.fetchval(
                """INSERT INTO miniapp_operations
                   (date, operation_type, description, amount,
                    expense_category, expense_subcategory,
                    payment_account, payment_method,
                    order_id, created_by_user_id, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, NOW())
                   RETURNING id""",
                op["date"],
                op["operation_type"],
                op["description"],
                op["amount"],
                op["expense_category"],
                op["expense_subcategory"],
                op["payment_account"],
                op["payment_method"],
                jon_id,
            )
            print(f"Inserted op id={op_id}: {op['description']}")
            if op["has_receipt"]:
                receipt_op_id = op_id

        # Save receipt
        if receipt_op_id is not None:
            receipt_path = Path("/tmp/receipt_jon.jpg")
            if not receipt_path.exists():
                print("ERROR: receipt file not found at /tmp/receipt_jon.jpg", file=sys.stderr)
                sys.exit(1)

            receipt_data = receipt_path.read_bytes()
            file_hash = hashlib.sha256(receipt_data).hexdigest()
            if file_hash != RECEIPT_HASH:
                print(f"WARNING: hash mismatch: got {file_hash}, expected {RECEIPT_HASH}")

            dest_dir = docs_dir / f"operation_{receipt_op_id}"
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest_file = dest_dir / RECEIPT_FILENAME
            dest_file.write_bytes(receipt_data)
            print(f"Saved receipt to {dest_file}")

            doc_id = await conn.fetchval(
                """INSERT INTO miniapp_documents
                   (order_id, operation_id, doc_kind, filename, file_hash, file_size, created_by_user_id, created_at)
                   VALUES (NULL, $1, 'receipt', $2, $3, $4, $5, NOW())
                   RETURNING id""",
                receipt_op_id,
                RECEIPT_FILENAME,
                file_hash,
                len(receipt_data),
                jon_id,
            )
            print(f"Inserted document id={doc_id}")

        print("Migration complete.")

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
