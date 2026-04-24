"""SQLite database service for clients, orders, operations, documents and recognition logs."""

from __future__ import annotations

import re
from uuid import uuid4

import aiosqlite

import config


def _get_db():
    """Returns DB connection factory."""
    return aiosqlite.connect(str(config.DATABASE_PATH))


def normalize_phone(raw_phone: str | None) -> str:
    """Normalizes phone to +7XXXXXXXXXX format when possible."""
    digits = re.sub(r"\D+", "", str(raw_phone or ""))
    if not digits:
        return ""

    if len(digits) == 11 and digits.startswith("8"):
        digits = "7" + digits[1:]
    elif len(digits) == 10:
        digits = "7" + digits

    if len(digits) == 11 and digits.startswith("7"):
        return f"+{digits}"
    return str(raw_phone or "").strip()


async def _ensure_column(db: aiosqlite.Connection, table: str, column: str, ddl: str):
    """Adds missing column to existing table."""
    cursor = await db.execute(f"PRAGMA table_info({table})")
    rows = await cursor.fetchall()
    existing = {row[1] for row in rows}
    if column not in existing:
        await db.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


async def init_db():
    """Creates DB and all required tables if they do not exist."""
    config.DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)

    async with _get_db() as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA foreign_keys=ON")

        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS clients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                phone TEXT NOT NULL UNIQUE,
                build_description TEXT,
                warranty_info TEXT,
                order_status TEXT,
                client_comment TEXT,
                telegram_username TEXT,
                created_by TEXT,
                updated_by TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT
            )
            """
        )
        await _ensure_column(db, "clients", "build_description", "build_description TEXT")
        await _ensure_column(db, "clients", "warranty_info", "warranty_info TEXT")
        await _ensure_column(db, "clients", "order_status", "order_status TEXT")
        await _ensure_column(db, "clients", "client_comment", "client_comment TEXT")
        await _ensure_column(db, "clients", "telegram_username", "telegram_username TEXT")
        await _ensure_column(db, "clients", "created_by", "created_by TEXT")
        await _ensure_column(db, "clients", "updated_by", "updated_by TEXT")
        await _ensure_column(db, "clients", "updated_at", "updated_at TEXT")

        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS customer_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL,
                order_phone TEXT NOT NULL,
                sale_type TEXT NOT NULL DEFAULT 'Сборка',
                status TEXT NOT NULL DEFAULT 'open',
                opened_by TEXT NOT NULL,
                closed_by TEXT,
                note TEXT,
                opened_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                closed_at TEXT,
                FOREIGN KEY (client_id) REFERENCES clients(id)
            )
            """
        )

        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                operation_type TEXT NOT NULL,
                expense_category TEXT,
                expense_subcategory TEXT,
                expense_block TEXT,
                client_id INTEGER,
                order_id INTEGER,
                order_phone TEXT,
                description TEXT NOT NULL,
                amount REAL NOT NULL,
                cost_price REAL,
                supplier TEXT,
                payment_source TEXT,
                payment_account TEXT,
                payment_method TEXT,
                income_channel TEXT,
                sale_type TEXT,
                business_direction TEXT,
                comment TEXT,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (client_id) REFERENCES clients(id),
                FOREIGN KEY (order_id) REFERENCES customer_orders(id)
            )
            """
        )
        await _ensure_column(db, "operations", "order_id", "order_id INTEGER")
        await _ensure_column(db, "operations", "order_phone", "order_phone TEXT")
        await _ensure_column(db, "operations", "payment_account", "payment_account TEXT")
        await _ensure_column(db, "operations", "business_direction", "business_direction TEXT")
        await _ensure_column(db, "operations", "income_channel", "income_channel TEXT")
        await _ensure_column(db, "operations", "sale_type", "sale_type TEXT")
        await _ensure_column(db, "operations", "expense_subcategory", "expense_subcategory TEXT")
        await _ensure_column(db, "operations", "expense_block", "expense_block TEXT")
        for legacy_name, canonical_name in config.LEGACY_PAYMENT_ACCOUNT_MAP.items():
            await db.execute(
                "UPDATE operations SET payment_account = ? WHERE payment_account = ?",
                (canonical_name, legacy_name),
            )

        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL,
                order_id INTEGER,
                doc_type TEXT NOT NULL,
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_hash TEXT,
                uploaded_by TEXT NOT NULL,
                uploaded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (client_id) REFERENCES clients(id),
                FOREIGN KEY (order_id) REFERENCES customer_orders(id)
            )
            """
        )
        await _ensure_column(db, "documents", "order_id", "order_id INTEGER")

        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS spec_documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                client_id INTEGER NOT NULL,
                document_id INTEGER,
                version INTEGER NOT NULL DEFAULT 1,
                parse_mode TEXT NOT NULL DEFAULT 'new_version',
                parse_status TEXT NOT NULL DEFAULT 'parsed',
                source_file_name TEXT NOT NULL,
                source_file_path TEXT NOT NULL,
                extracted_payload TEXT,
                customer_total REAL,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (order_id) REFERENCES customer_orders(id),
                FOREIGN KEY (client_id) REFERENCES clients(id),
                FOREIGN KEY (document_id) REFERENCES documents(id)
            )
            """
        )
        await _ensure_column(db, "spec_documents", "document_id", "document_id INTEGER")
        await _ensure_column(db, "spec_documents", "version", "version INTEGER NOT NULL DEFAULT 1")
        await _ensure_column(db, "spec_documents", "parse_mode", "parse_mode TEXT NOT NULL DEFAULT 'new_version'")
        await _ensure_column(db, "spec_documents", "parse_status", "parse_status TEXT NOT NULL DEFAULT 'parsed'")
        await _ensure_column(db, "spec_documents", "source_file_name", "source_file_name TEXT")
        await _ensure_column(db, "spec_documents", "source_file_path", "source_file_path TEXT")
        await _ensure_column(db, "spec_documents", "extracted_payload", "extracted_payload TEXT")
        await _ensure_column(db, "spec_documents", "customer_total", "customer_total REAL")

        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS spec_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                spec_document_id INTEGER NOT NULL,
                item_index INTEGER NOT NULL,
                component_name TEXT NOT NULL,
                component_value TEXT,
                confidence REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'unconfirmed',
                purchase_price REAL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (spec_document_id) REFERENCES spec_documents(id)
            )
            """
        )
        await _ensure_column(db, "spec_items", "item_index", "item_index INTEGER NOT NULL DEFAULT 1")
        await _ensure_column(db, "spec_items", "component_name", "component_name TEXT")
        await _ensure_column(db, "spec_items", "component_value", "component_value TEXT")
        await _ensure_column(db, "spec_items", "confidence", "confidence REAL NOT NULL DEFAULT 0")
        await _ensure_column(db, "spec_items", "status", "status TEXT NOT NULL DEFAULT 'unconfirmed'")
        await _ensure_column(db, "spec_items", "purchase_price", "purchase_price REAL")
        await _ensure_column(db, "spec_items", "purchase_account", "purchase_account TEXT")
        for legacy_name, canonical_name in config.LEGACY_PAYMENT_ACCOUNT_MAP.items():
            await db.execute(
                "UPDATE spec_items SET purchase_account = ? WHERE purchase_account = ?",
                (canonical_name, legacy_name),
            )

        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS recognition_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_text TEXT NOT NULL,
                parser_mode TEXT NOT NULL DEFAULT 'unknown',
                status TEXT NOT NULL,
                parsed_payload TEXT,
                final_payload TEXT,
                correction_text TEXT,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
            """
        )

        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                actor_user_id INTEGER,
                actor_name TEXT,
                actor_role TEXT,
                command_name TEXT,
                details TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
            """
        )

        await db.commit()


# ==================== CLIENTS ====================

async def add_client(full_name: str, phone: str, created_by: str | None = None) -> int:
    """Adds a new client and returns its ID."""
    normalized_phone = normalize_phone(phone)
    if not normalized_phone:
        normalized_phone = f"auto:{uuid4().hex}"
    normalized_name = (full_name or "").strip() or f"Клиент {normalized_phone}"

    async with _get_db() as db:
        cursor = await db.execute(
            "INSERT INTO clients (full_name, phone, created_by) VALUES (?, ?, ?)",
            (normalized_name, normalized_phone, created_by),
        )
        await db.commit()
        return cursor.lastrowid


async def get_or_create_client_by_name(full_name: str) -> int:
    """Finds client by exact name (case-insensitive) or creates a new one."""
    normalized_name = (full_name or "").strip()
    if not normalized_name:
        raise ValueError("Client name is required")

    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT id, full_name FROM clients")
        rows = await cursor.fetchall()
        for row in rows:
            if str(row["full_name"]).strip().casefold() == normalized_name.casefold():
                return int(row["id"])

    generated_phone = f"auto:{uuid4().hex}"
    return await add_client(normalized_name, generated_phone)


async def get_or_create_client_by_phone(
    phone: str,
    full_name: str | None = None,
    telegram_username: str | None = None,
    created_by: str | None = None,
) -> tuple[int, bool]:
    """Finds client by phone or creates it. Returns (client_id, created_flag)."""
    normalized_phone = normalize_phone(phone)
    if not normalized_phone:
        raise ValueError("Phone is required")

    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM clients WHERE phone = ?", (normalized_phone,))
        row = await cursor.fetchone()
        if row:
            updates = {}
            if full_name and full_name.strip() and not str(row["full_name"]).strip():
                updates["full_name"] = full_name.strip()
            if telegram_username and not row["telegram_username"]:
                updates["telegram_username"] = telegram_username
            if updates:
                await update_client(row["id"], updated_by=created_by, **updates)
            return int(row["id"]), False

    client_name = (full_name or "").strip() or f"Клиент {normalized_phone}"
    client_id = await add_client(client_name, normalized_phone, created_by=created_by)
    if telegram_username:
        await update_client(client_id, telegram_username=telegram_username, updated_by=created_by)
    return client_id, True


async def update_client(client_id: int, updated_by: str | None = None, **kwargs) -> bool:
    """Updates client card fields."""
    if not kwargs and not updated_by:
        return False

    update_data = dict(kwargs)
    if "phone" in update_data:
        update_data["phone"] = normalize_phone(update_data["phone"])
    update_data["updated_at"] = "datetime('now', 'localtime')"
    if updated_by:
        update_data["updated_by"] = updated_by

    clauses = []
    values: list[object] = []
    for key, value in update_data.items():
        if key == "updated_at":
            clauses.append("updated_at = datetime('now', 'localtime')")
        else:
            clauses.append(f"{key} = ?")
            values.append(value)
    values.append(client_id)

    async with _get_db() as db:
        cursor = await db.execute(
            f"UPDATE clients SET {', '.join(clauses)} WHERE id = ?",
            values,
        )
        await db.commit()
        return cursor.rowcount > 0


async def find_client_by_name(name: str) -> list[dict]:
    """Finds clients by partial name match."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM clients WHERE full_name LIKE ? ORDER BY full_name",
            (f"%{name}%",),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def find_client_by_phone(phone: str) -> dict | None:
    """Finds client by exact phone number."""
    normalized_phone = normalize_phone(phone)
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM clients WHERE phone = ?",
            (normalized_phone,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_client_by_id(client_id: int) -> dict | None:
    """Gets client by ID."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM clients WHERE id = ?",
            (client_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_all_clients() -> list[dict]:
    """Returns all clients."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM clients ORDER BY full_name")
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


# ==================== ORDERS ====================

async def create_order(
    client_id: int,
    order_phone: str,
    opened_by: str,
    sale_type: str = "Сборка",
    note: str | None = None,
) -> int:
    """Creates a new customer order and returns order ID."""
    normalized_phone = normalize_phone(order_phone) or order_phone
    async with _get_db() as db:
        cursor = await db.execute(
            """
            INSERT INTO customer_orders
            (client_id, order_phone, sale_type, opened_by, note)
            VALUES (?, ?, ?, ?, ?)
            """,
            (client_id, normalized_phone, sale_type or "Сборка", opened_by, note),
        )
        await db.commit()
        return cursor.lastrowid


async def close_order(order_id: int, closed_by: str) -> bool:
    """Closes order by id in the bot's SQLite DB (bot.db).

    LEGACY: sets status='closed' only. Does NOT touch the miniapp PostgreSQL
    database and has NO financial invariant checks (sale/payment/COGS).
    Use the Mini App /orders/{id}/finalize endpoint for proper order closure.
    """
    async with _get_db() as db:
        cursor = await db.execute(
            """
            UPDATE customer_orders
            SET status = 'closed',
                closed_by = ?,
                closed_at = datetime('now', 'localtime')
            WHERE id = ? AND status = 'open'
            """,
            (closed_by, order_id),
        )
        await db.commit()
        return cursor.rowcount > 0


async def get_order_by_id(order_id: int) -> dict | None:
    """Returns order with joined client fields."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT o.*, c.full_name as client_name, c.phone as client_phone
            FROM customer_orders o
            JOIN clients c ON c.id = o.client_id
            WHERE o.id = ?
            """,
            (order_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_latest_order_for_phone(phone: str) -> dict | None:
    """Returns latest order for a phone, regardless of status."""
    normalized_phone = normalize_phone(phone)
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT o.*, c.full_name as client_name, c.phone as client_phone
            FROM customer_orders o
            JOIN clients c ON c.id = o.client_id
            WHERE o.order_phone = ?
            ORDER BY o.id DESC
            LIMIT 1
            """,
            (normalized_phone,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_order_totals(order_id: int) -> dict:
    """Returns aggregated totals for order."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT
                SUM(CASE WHEN operation_type IN ('продажа', 'предоплата', 'постоплата') THEN amount ELSE 0 END) as income_total,
                SUM(
                    CASE
                        WHEN operation_type = 'закупка'
                         AND (comment IS NULL OR comment NOT LIKE 'spec_aggregate:%')
                        THEN amount
                        ELSE 0
                    END
                ) as cogs_total,
                SUM(CASE WHEN operation_type = 'расход' THEN amount ELSE 0 END) as opex_total,
                COUNT(
                    CASE
                        WHEN comment IS NULL OR comment NOT LIKE 'spec_aggregate:%'
                        THEN 1
                    END
                ) as operations_count
            FROM operations
            WHERE order_id = ?
            """,
            (order_id,),
        )
        row = await cursor.fetchone()
        return {
            "income_total": float(row["income_total"] or 0.0),
            "cogs_total": float(row["cogs_total"] or 0.0),
            "opex_total": float(row["opex_total"] or 0.0),
            "operations_count": int(row["operations_count"] or 0),
        }


async def delete_order_if_empty(order_id: int) -> dict:
    """
    Deletes order only when it has no operations/documents.

    If client becomes fully unused, removes client card too.
    """
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        order_cursor = await db.execute(
            "SELECT * FROM customer_orders WHERE id = ?",
            (order_id,),
        )
        order = await order_cursor.fetchone()
        if not order:
            return {"deleted": False, "reason": "not_found"}

        ops_cursor = await db.execute(
            "SELECT COUNT(*) as cnt FROM operations WHERE order_id = ?",
            (order_id,),
        )
        ops_count = int((await ops_cursor.fetchone())["cnt"])

        docs_cursor = await db.execute(
            "SELECT COUNT(*) as cnt FROM documents WHERE order_id = ?",
            (order_id,),
        )
        docs_count = int((await docs_cursor.fetchone())["cnt"])

        if ops_count > 0 or docs_count > 0:
            return {
                "deleted": False,
                "reason": "not_empty",
                "operations_count": ops_count,
                "documents_count": docs_count,
            }

        await db.execute("DELETE FROM customer_orders WHERE id = ?", (order_id,))

        client_id = int(order["client_id"])
        remain_orders_cursor = await db.execute(
            "SELECT COUNT(*) as cnt FROM customer_orders WHERE client_id = ?",
            (client_id,),
        )
        remain_orders = int((await remain_orders_cursor.fetchone())["cnt"])

        remain_ops_cursor = await db.execute(
            "SELECT COUNT(*) as cnt FROM operations WHERE client_id = ?",
            (client_id,),
        )
        remain_ops = int((await remain_ops_cursor.fetchone())["cnt"])

        remain_docs_cursor = await db.execute(
            "SELECT COUNT(*) as cnt FROM documents WHERE client_id = ?",
            (client_id,),
        )
        remain_docs = int((await remain_docs_cursor.fetchone())["cnt"])

        deleted_client = False
        if remain_orders == 0 and remain_ops == 0 and remain_docs == 0:
            client_delete = await db.execute("DELETE FROM clients WHERE id = ?", (client_id,))
            deleted_client = client_delete.rowcount > 0

        await db.commit()
        return {
            "deleted": True,
            "deleted_client": deleted_client,
            "order_phone": str(order["order_phone"]),
        }


# ==================== OPERATIONS ====================

async def add_operation(
    date: str,
    operation_type: str,
    description: str,
    amount: float,
    created_by: str,
    expense_category: str | None = None,
    expense_subcategory: str | None = None,
    expense_block: str | None = None,
    client_id: int | None = None,
    order_id: int | None = None,
    order_phone: str | None = None,
    cost_price: float | None = None,
    supplier: str | None = None,
    payment_source: str | None = None,
    payment_account: str | None = None,
    payment_method: str | None = None,
    income_channel: str | None = None,
    sale_type: str | None = None,
    business_direction: str | None = None,
    comment: str | None = None,
) -> int:
    """Adds a new operation and returns operation ID."""
    normalized_phone = normalize_phone(order_phone) if order_phone else None
    async with _get_db() as db:
        cursor = await db.execute(
            """
            INSERT INTO operations
            (date, operation_type, expense_category, expense_subcategory, expense_block, client_id, order_id, order_phone, description,
             amount, cost_price, supplier, payment_source, payment_account, payment_method, income_channel,
             sale_type, business_direction, comment, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                date,
                operation_type,
                expense_category,
                expense_subcategory,
                expense_block,
                client_id,
                order_id,
                normalized_phone,
                description,
                amount,
                cost_price,
                supplier,
                payment_source,
                payment_account,
                payment_method,
                income_channel,
                sale_type,
                business_direction,
                comment,
                created_by,
            ),
        )
        await db.commit()
        return cursor.lastrowid


async def get_last_operation(created_by: str | None = None) -> dict | None:
    """Returns latest operation, optionally filtered by creator."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        if created_by:
            cursor = await db.execute(
                "SELECT * FROM operations WHERE created_by = ? ORDER BY id DESC LIMIT 1",
                (created_by,),
            )
        else:
            cursor = await db.execute("SELECT * FROM operations ORDER BY id DESC LIMIT 1")
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_operation_by_id(operation_id: int) -> dict | None:
    """Returns one operation with client info by id."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT o.*, c.full_name as client_name, c.phone as client_phone
            FROM operations o
            LEFT JOIN clients c ON o.client_id = c.id
            WHERE o.id = ?
            """,
            (operation_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def list_recent_operations(limit: int = 10, created_by: str | None = None) -> list[dict]:
    """Returns recent operations for helper commands like delete."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        if created_by:
            cursor = await db.execute(
                """
                SELECT id, date, operation_type, description, amount, payment_account
                FROM operations
                WHERE created_by = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (created_by, limit),
            )
        else:
            cursor = await db.execute(
                """
                SELECT id, date, operation_type, description, amount, payment_account
                FROM operations
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def delete_operation(operation_id: int) -> bool:
    """Deletes operation by id."""
    async with _get_db() as db:
        cursor = await db.execute("DELETE FROM operations WHERE id = ?", (operation_id,))
        await db.commit()
        return cursor.rowcount > 0


async def update_operation(operation_id: int, **kwargs) -> bool:
    """Updates operation fields, returns True if row changed."""
    if not kwargs:
        return False
    set_clause = ", ".join(f"{key} = ?" for key in kwargs)
    values = list(kwargs.values()) + [operation_id]

    async with _get_db() as db:
        cursor = await db.execute(
            f"UPDATE operations SET {set_clause} WHERE id = ?",
            values,
        )
        await db.commit()
        return cursor.rowcount > 0


async def get_operations_by_period(
    start_date: str,
    end_date: str,
    operation_type: str | None = None,
    created_by: str | None = None,
) -> list[dict]:
    """Returns operations for date range, optionally filtered by type."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        if operation_type and created_by:
            cursor = await db.execute(
                """
                SELECT o.*, c.full_name as client_name, c.phone as client_phone
                FROM operations o
                LEFT JOIN clients c ON o.client_id = c.id
                WHERE o.date >= ? AND o.date <= ? AND o.operation_type = ? AND o.created_by = ?
                ORDER BY o.date DESC, o.id DESC
                """,
                (start_date, end_date, operation_type, created_by),
            )
        elif operation_type:
            cursor = await db.execute(
                """
                SELECT o.*, c.full_name as client_name, c.phone as client_phone
                FROM operations o
                LEFT JOIN clients c ON o.client_id = c.id
                WHERE o.date >= ? AND o.date <= ? AND o.operation_type = ?
                ORDER BY o.date DESC, o.id DESC
                """,
                (start_date, end_date, operation_type),
            )
        elif created_by:
            cursor = await db.execute(
                """
                SELECT o.*, c.full_name as client_name, c.phone as client_phone
                FROM operations o
                LEFT JOIN clients c ON o.client_id = c.id
                WHERE o.date >= ? AND o.date <= ? AND o.created_by = ?
                ORDER BY o.date DESC, o.id DESC
                """,
                (start_date, end_date, created_by),
            )
        else:
            cursor = await db.execute(
                """
                SELECT o.*, c.full_name as client_name, c.phone as client_phone
                FROM operations o
                LEFT JOIN clients c ON o.client_id = c.id
                WHERE o.date >= ? AND o.date <= ?
                ORDER BY o.date DESC, o.id DESC
                """,
                (start_date, end_date),
            )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_operations_by_order(order_id: int) -> list[dict]:
    """Returns operations linked to order."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT o.*, c.full_name as client_name, c.phone as client_phone
            FROM operations o
            LEFT JOIN clients c ON o.client_id = c.id
            WHERE o.order_id = ?
            ORDER BY o.date ASC, o.id ASC
            """,
            (order_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_all_operations_for_export() -> list[dict]:
    """Returns all operations with client and order fields for spreadsheet sync."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT
                o.*,
                c.full_name as client_name,
                c.phone as client_phone,
                ord.status as order_status,
                ord.sale_type as order_sale_type,
                ord.opened_at as order_opened_at
            FROM operations o
            LEFT JOIN clients c ON o.client_id = c.id
            LEFT JOIN customer_orders ord ON o.order_id = ord.id
            ORDER BY o.id ASC
            """
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


# ==================== DOCUMENTS ====================

async def add_document(
    client_id: int,
    doc_type: str,
    file_name: str,
    file_path: str,
    uploaded_by: str,
    order_id: int | None = None,
    file_hash: str | None = None,
) -> int:
    """Adds document record and returns document ID."""
    async with _get_db() as db:
        cursor = await db.execute(
            """
            INSERT INTO documents
            (client_id, order_id, doc_type, file_name, file_path, file_hash, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (client_id, order_id, doc_type, file_name, file_path, file_hash, uploaded_by),
        )
        await db.commit()
        return cursor.lastrowid


async def find_document_by_hash(client_id: int, file_hash: str, order_id: int | None = None) -> dict | None:
    """Finds duplicate document by client+hash (and optionally order)."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        if order_id:
            cursor = await db.execute(
                "SELECT * FROM documents WHERE client_id = ? AND order_id = ? AND file_hash = ?",
                (client_id, order_id, file_hash),
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM documents WHERE client_id = ? AND file_hash = ?",
                (client_id, file_hash),
            )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_documents_by_client(client_id: int) -> list[dict]:
    """Returns documents for client."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM documents WHERE client_id = ? ORDER BY uploaded_at DESC",
            (client_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_documents_by_order(order_id: int) -> list[dict]:
    """Returns documents for order."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM documents WHERE order_id = ? ORDER BY uploaded_at DESC",
            (order_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


# ==================== SPECS ====================

async def get_latest_spec_document_for_order(order_id: int) -> dict | None:
    """Returns latest spec document for an order."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT *
            FROM spec_documents
            WHERE order_id = ?
            ORDER BY version DESC, id DESC
            LIMIT 1
            """,
            (order_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_primary_spec_document_for_order(order_id: int) -> dict | None:
    """Returns the first (primary) spec document for an order."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT *
            FROM spec_documents
            WHERE order_id = ? AND parse_mode = 'primary'
            ORDER BY id DESC
            LIMIT 1
            """,
            (order_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def list_spec_documents_by_order(order_id: int) -> list[dict]:
    """Returns all specs linked to order."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT *
            FROM spec_documents
            WHERE order_id = ?
            ORDER BY version DESC, id DESC
            """,
            (order_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def set_spec_documents_status_for_order(order_id: int, status: str) -> int:
    """Bulk-updates spec status for order and returns number of affected rows."""
    async with _get_db() as db:
        cursor = await db.execute(
            "UPDATE spec_documents SET parse_status = ? WHERE order_id = ?",
            (status, order_id),
        )
        await db.commit()
        return int(cursor.rowcount or 0)


async def add_spec_document(
    order_id: int,
    client_id: int,
    source_file_name: str,
    source_file_path: str,
    created_by: str,
    *,
    document_id: int | None = None,
    version: int = 1,
    parse_mode: str = "new_version",
    parse_status: str = "parsed",
    extracted_payload: str | None = None,
    customer_total: float | None = None,
) -> int:
    """Creates specification document record and returns ID."""
    async with _get_db() as db:
        cursor = await db.execute(
            """
            INSERT INTO spec_documents
            (order_id, client_id, document_id, version, parse_mode, parse_status, source_file_name,
             source_file_path, extracted_payload, customer_total, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                order_id,
                client_id,
                document_id,
                version,
                parse_mode,
                parse_status,
                source_file_name,
                source_file_path,
                extracted_payload,
                customer_total,
                created_by,
            ),
        )
        await db.commit()
        return int(cursor.lastrowid)


async def add_spec_items(spec_document_id: int, items: list[dict]) -> int:
    """Adds spec item rows. Returns inserted rows count."""
    if not items:
        return 0

    payload = []
    for index, item in enumerate(items, start=1):
        payload.append(
            (
                spec_document_id,
                int(item.get("item_index") or index),
                str(item.get("component_name") or "Позиция").strip(),
                str(item.get("component_value") or "").strip() or None,
                float(item.get("confidence") or 0.0),
                str(item.get("status") or "unconfirmed").strip() or "unconfirmed",
                item.get("purchase_price"),
                str(item.get("purchase_account") or "").strip() or None,
            )
        )

    async with _get_db() as db:
        await db.executemany(
            """
            INSERT INTO spec_items
            (spec_document_id, item_index, component_name, component_value, confidence, status, purchase_price, purchase_account)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            payload,
        )
        await db.commit()
        return len(payload)


async def get_spec_document_by_id(spec_document_id: int) -> dict | None:
    """Returns one specification by ID."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM spec_documents WHERE id = ?",
            (spec_document_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def list_spec_items(spec_document_id: int) -> list[dict]:
    """Returns item rows for specification."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT *
            FROM spec_items
            WHERE spec_document_id = ?
            ORDER BY item_index ASC, id ASC
            """,
            (spec_document_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_next_unpriced_spec_item(spec_document_id: int) -> dict | None:
    """Returns first item without purchase price."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT *
            FROM spec_items
            WHERE spec_document_id = ?
              AND purchase_price IS NULL
              AND status NOT IN ('manual_review', 'skipped')
            ORDER BY item_index ASC, id ASC
            LIMIT 1
            """,
            (spec_document_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def update_spec_item_price(
    item_id: int,
    purchase_price: float,
    status: str = "confirmed",
    purchase_account: str | None = None,
) -> bool:
    """Sets purchase price for spec item."""
    async with _get_db() as db:
        cursor = await db.execute(
            """
            UPDATE spec_items
            SET purchase_price = ?, status = ?, purchase_account = COALESCE(?, purchase_account)
            WHERE id = ?
            """,
            (purchase_price, status, purchase_account, item_id),
        )
        await db.commit()
        return cursor.rowcount > 0


async def count_unpriced_spec_items(spec_document_id: int) -> int:
    """Counts items without purchase price."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT COUNT(*) as cnt
            FROM spec_items
            WHERE spec_document_id = ?
              AND purchase_price IS NULL
              AND status NOT IN ('manual_review', 'skipped')
            """,
            (spec_document_id,),
        )
        row = await cursor.fetchone()
        return int(row["cnt"] or 0)


async def update_spec_item_status(item_id: int, status: str) -> bool:
    """Updates status for one spec item."""
    async with _get_db() as db:
        cursor = await db.execute(
            "UPDATE spec_items SET status = ? WHERE id = ?",
            (status, item_id),
        )
        await db.commit()
        return cursor.rowcount > 0


async def get_all_spec_items_for_export() -> list[dict]:
    """Returns full spec registry for Google Sheets export."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT
                sd.id as spec_document_id,
                sd.order_id,
                sd.client_id,
                sd.version,
                sd.parse_mode,
                sd.parse_status,
                sd.source_file_name,
                sd.created_at as spec_created_at,
                sd.customer_total,
                si.id as spec_item_id,
                si.item_index,
                si.component_name,
                si.component_value,
                si.confidence,
                si.status as item_status,
                si.purchase_price,
                si.purchase_account,
                c.full_name as client_name,
                c.phone as client_phone,
                o.order_phone
            FROM spec_documents sd
            LEFT JOIN spec_items si ON si.spec_document_id = sd.id
            LEFT JOIN clients c ON c.id = sd.client_id
            LEFT JOIN customer_orders o ON o.id = sd.order_id
            ORDER BY sd.id ASC, si.item_index ASC, si.id ASC
            """
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


# ==================== RECOGNITION LOGS ====================

async def add_recognition_log(
    source_text: str,
    created_by: str,
    status: str,
    parser_mode: str = "unknown",
    parsed_payload: str | None = None,
    final_payload: str | None = None,
    correction_text: str | None = None,
) -> int:
    """Adds recognition quality log entry and returns log ID."""
    async with _get_db() as db:
        cursor = await db.execute(
            """
            INSERT INTO recognition_logs
            (source_text, parser_mode, status, parsed_payload, final_payload, correction_text, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_text,
                parser_mode,
                status,
                parsed_payload,
                final_payload,
                correction_text,
                created_by,
            ),
        )
        await db.commit()
        return cursor.lastrowid


async def get_recognition_logs(limit: int = 100) -> list[dict]:
    """Returns latest recognition logs for prompt quality analysis."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM recognition_logs ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def add_audit_log(
    event_type: str,
    *,
    actor_user_id: int | None = None,
    actor_name: str | None = None,
    actor_role: str | None = None,
    command_name: str | None = None,
    details: str | None = None,
) -> int:
    """Adds security/administrative event into audit log."""
    async with _get_db() as db:
        cursor = await db.execute(
            """
            INSERT INTO audit_logs
            (event_type, actor_user_id, actor_name, actor_role, command_name, details)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                event_type,
                actor_user_id,
                actor_name,
                actor_role,
                command_name,
                details,
            ),
        )
        await db.commit()
        return int(cursor.lastrowid)


async def wipe_all_business_data() -> dict[str, int]:
    """
    Deletes all transactional/accounting data.

    Keeps table schema intact.
    """
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        counts: dict[str, int] = {}
        for table in (
            "recognition_logs",
            "spec_items",
            "spec_documents",
            "documents",
            "operations",
            "customer_orders",
            "clients",
        ):
            cursor = await db.execute(f"SELECT COUNT(*) as cnt FROM {table}")
            row = await cursor.fetchone()
            counts[table] = int(row["cnt"] or 0)

        await db.execute("DELETE FROM recognition_logs")
        await db.execute("DELETE FROM spec_items")
        await db.execute("DELETE FROM spec_documents")
        await db.execute("DELETE FROM documents")
        await db.execute("DELETE FROM operations")
        await db.execute("DELETE FROM customer_orders")
        await db.execute("DELETE FROM clients")
        await db.execute(
            "DELETE FROM sqlite_sequence WHERE name IN ('clients','customer_orders','operations','documents','spec_documents','spec_items','recognition_logs')"
        )
        await db.commit()
        return counts


async def count_order_receipts(order_id: int) -> int:
    """Counts receipt-like documents for an order."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT COUNT(*) AS cnt
            FROM documents
            WHERE order_id = ?
              AND doc_type = 'чек'
            """,
            (order_id,),
        )
        row = await cursor.fetchone()
        return int(row["cnt"] or 0)
