#!/usr/bin/env python3
"""Quick smoke scenarios for Telegram DDS accounts with autonomous PASS/FAIL table."""

from __future__ import annotations

import argparse
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SmokeCase:
    code: str
    phrase: str
    expected_saved: bool
    expected_operation_type: str | None = None
    expected_account: str | None = None
    expected_category: str | None = None
    note: str = ""


SMOKE_CASES = [
    SmokeCase(
        code="SMK1",
        phrase="закупка smk1 ssd kingston 12000 по заказу +79990001122",
        expected_saved=True,
        expected_operation_type="закупка",
        expected_account="ИП Каменский АБ",
        expected_category="Комплектующие",
        note="Проверка дефолта закупки без явного счета.",
    ),
    SmokeCase(
        code="SMK2",
        phrase="закупка smk2 видеокарта 13500 по заказу +79990001122 счет кам вб",
        expected_saved=True,
        expected_operation_type="закупка",
        expected_account="Каменский ВБ",
        expected_category="Комплектующие",
        note="Проверка алиаса `кам вб`.",
    ),
    SmokeCase(
        code="SMK3",
        phrase="закупка smk3 блок питания 6700 по заказу +79990001122 счет ант вб",
        expected_saved=True,
        expected_operation_type="закупка",
        expected_account="Антропов ВБ",
        expected_category="Комплектующие",
        note="Проверка алиаса `ант вб`.",
    ),
    SmokeCase(
        code="SMK4",
        phrase="закупка smk4 кулер 2300 по заказу +79990001122 счет кам об",
        expected_saved=True,
        expected_operation_type="закупка",
        expected_account="Каменский ОБ",
        expected_category="Комплектующие",
        note="Проверка алиаса `кам об`.",
    ),
    SmokeCase(
        code="SMK5",
        phrase="расход smk5 аренда офиса 30000",
        expected_saved=False,
        note="Ожидается уточнение счета, операция не должна сохраниться после 1-й фразы.",
    ),
    SmokeCase(
        code="SMK6",
        phrase="расход smk6 вода в офис 900 нал",
        expected_saved=True,
        expected_operation_type="расход",
        expected_account="Наличные",
        expected_category="Офис",
        note="Проверка алиаса `нал` и классификации офисного расхода.",
    ),
]


def _default_db_path() -> Path:
    env_path = os.getenv("DATABASE_PATH", "").strip()
    if env_path:
        return Path(env_path)
    return Path("data/bot.db")


def _find_operation_by_marker(conn: sqlite3.Connection, marker: str) -> dict | None:
    pattern = f"%{marker.lower()}%"
    row = conn.execute(
        """
        SELECT id, date, operation_type, payment_account, expense_category, expense_subcategory, description
        FROM operations
        WHERE lower(description) LIKE ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (pattern,),
    ).fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "date": row[1],
        "operation_type": row[2],
        "payment_account": row[3],
        "expense_category": row[4],
        "expense_subcategory": row[5],
        "description": row[6],
    }


def _print_phrases() -> None:
    print("=== Telegram DDS Smoke (6 фраз) ===")
    print("Отправляйте фразы по порядку. Для SMK1/2/3/4/6 после карточки пишите `ок`.")
    print("Для SMK5 после первой фразы НЕ подтверждайте, проверьте, что бот просит счет.\n")
    for index, case in enumerate(SMOKE_CASES, start=1):
        print(f"{index}. {case.phrase}")
        print(f"   -> {case.note}")


def _evaluate_case(case: SmokeCase, operation: dict | None) -> tuple[str, str]:
    if not case.expected_saved:
        if operation is None:
            return "PASS", "Операция не сохранена как и ожидается."
        return "FAIL", f"Найдена операция #{operation['id']}, а ожидалось отсутствие сохранения."

    if operation is None:
        return "FAIL", "Операция не найдена (возможно не было `ок`)."

    mismatches: list[str] = []
    if case.expected_operation_type and operation["operation_type"] != case.expected_operation_type:
        mismatches.append(f"type={operation['operation_type']}")
    if case.expected_account and operation["payment_account"] != case.expected_account:
        mismatches.append(f"account={operation['payment_account']}")
    if case.expected_category and operation["expense_category"] != case.expected_category:
        mismatches.append(f"category={operation['expense_category']}")

    if mismatches:
        return "FAIL", "; ".join(mismatches)
    return "PASS", f"Операция #{operation['id']} совпала с ожиданием."


def _print_table(rows: list[list[str]]) -> None:
    widths = [max(len(str(row[col])) for row in rows) for col in range(len(rows[0]))]
    for ridx, row in enumerate(rows):
        line = " | ".join(str(cell).ljust(widths[cidx]) for cidx, cell in enumerate(row))
        print(line)
        if ridx == 0:
            print("-+-".join("-" * width for width in widths))


def _run_check(db_path: Path) -> int:
    if not db_path.exists():
        print(f"DB file not found: {db_path}")
        return 2

    rows: list[list[str]] = [
        ["Case", "Expected", "Result", "Details"],
    ]
    failures = 0

    with sqlite3.connect(str(db_path)) as conn:
        for case in SMOKE_CASES:
            operation = _find_operation_by_marker(conn, case.code.lower())
            status, details = _evaluate_case(case, operation)
            if status != "PASS":
                failures += 1
            expected = "saved" if case.expected_saved else "not saved"
            rows.append([case.code, expected, status, details])

    _print_table(rows)
    print(f"\nSummary: {len(SMOKE_CASES) - failures}/{len(SMOKE_CASES)} PASS")
    return 0 if failures == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="DDS smoke helper for Telegram scenarios.")
    parser.add_argument("--db", default=str(_default_db_path()), help="Path to sqlite database (default: data/bot.db).")
    parser.add_argument("--phrases", action="store_true", help="Print 6 smoke phrases for Telegram.")
    parser.add_argument("--check", action="store_true", help="Run autonomous PASS/FAIL table using DB markers.")
    args = parser.parse_args()

    if not args.phrases and not args.check:
        args.phrases = True
        args.check = True

    if args.phrases:
        _print_phrases()
        print("")

    if args.check:
        return _run_check(Path(args.db))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
