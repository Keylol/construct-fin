import requests

from bot.services import sheets


def test_build_expense_journal_rows_contains_order_phone():
    rows = sheets.build_expense_journal_rows(
        [
            {
                "id": 1,
                "date": "2026-04-01",
                "operation_type": "закупка",
                "description": "RTX 4060",
                "amount": 45000,
                "payment_account": "ИП Каменский АБ",
                "supplier": "DNS",
                "order_phone": "+79990001122",
            }
        ]
    )

    assert rows[0][0] == "Дата"
    assert rows[1][1] == "Комплектующие"
    assert rows[1][6] == "+79990001122"


def test_build_income_rows_calculates_cogs_by_order():
    all_operations = [
        {
            "id": 1,
            "date": "2026-04-01",
            "operation_type": "закупка",
            "amount": 60000,
            "order_id": 10,
            "order_phone": "+79990001122",
        },
        {
            "id": 2,
            "date": "2026-04-02",
            "operation_type": "продажа",
            "description": "Сборка ПК",
            "amount": 100000,
            "order_id": 10,
            "order_phone": "+79990001122",
            "client_name": "Иванов",
            "sale_type": "Сборка",
            "income_channel": "Онлайн",
            "payment_account": "Каменский ВБ",
        },
    ]
    month_operations = all_operations

    rows = sheets.build_income_rows(month_operations, all_operations)

    assert rows[0][0] == "Дата"
    assert rows[1][6] == 60000
    assert rows[1][7] == 40000
    assert rows[1][8] == 40.0


def test_build_month_summary_rows_contains_five_lines():
    rows = sheets.build_month_summary_rows(
        [
            {"operation_type": "продажа", "amount": 100000, "order_id": 10},
            {"operation_type": "закупка", "amount": 60000, "order_id": 10},
            {"operation_type": "расход", "amount": 10000},
        ],
        all_operations=[
            {"operation_type": "продажа", "amount": 100000, "order_id": 10},
            {"operation_type": "закупка", "amount": 60000, "order_id": 10},
            {"operation_type": "расход", "amount": 10000},
        ],
    )

    assert rows[1][0] == "Выручка"
    assert rows[2][0] == "Себестоимость"
    assert rows[3][0] == "Валовая прибыль"
    assert rows[4][0] == "Оперрасходы"
    assert rows[5][0] == "Чистая прибыль"
    assert rows[5][1] == 30000


def test_sale_correction_counts_as_revenue_without_double_cogs():
    rows = sheets.build_month_summary_rows(
        [
            {"operation_type": "корректировка продажи", "amount": 2000, "order_id": 10, "order_status": "closed"},
        ],
        all_operations=[
            {"operation_type": "продажа", "amount": 100000, "order_id": 10, "order_status": "closed"},
            {"operation_type": "закупка", "amount": 60000, "order_id": 10},
            {"operation_type": "корректировка продажи", "amount": 2000, "order_id": 10, "order_status": "closed"},
        ],
    )

    assert rows[1][1] == 2000
    assert rows[2][1] == 0.0
    assert rows[5][1] == 2000


def test_build_dashboard_rows_has_dds_opiu_budget_blocks():
    month_ops = {
        "2026-04": [
            {"operation_type": "продажа", "amount": 100000},
            {"operation_type": "закупка", "amount": 60000},
            {"operation_type": "расход", "amount": 10000},
        ]
    }
    budget_plan = {"2026-04": {"net": 35000}}

    rows, months, _ = sheets.build_dashboard_rows(month_ops, budget_plan)

    assert months == ["2026-04"]
    assert rows[2][2] == "2026-04"
    assert any(row[0] == "ДДС" and row[1] == "Чистый поток" for row in rows[3:])
    assert any(row[0] == "ОПиУ" and row[1] == "Чистая прибыль" for row in rows[3:])
    assert any(row[0] == "Бюджет" and row[1] == "План чистой прибыли" for row in rows[3:])


def test_build_dashboard_rows_contains_top_kpi_summary():
    month_ops = {
        "2026-04": [
            {"operation_type": "продажа", "amount": 100000, "order_id": 10},
            {"operation_type": "закупка", "amount": 60000, "order_id": 10},
        ]
    }
    budget_plan = {"2026-04": {"net": 35000}}

    rows, _, _ = sheets.build_dashboard_rows(month_ops, budget_plan, selected_period="2026-04")

    assert rows[0][0] == "Dashboard"
    assert rows[0][3] == "Валовая прибыль"
    assert rows[0][5] == "Маржа %"
    assert rows[0][7] == "Чистая прибыль"
    assert rows[0][9] == "ДДС чистый поток"


def test_build_operations_register_rows_sets_expense_block_and_subcategory():
    rows = sheets.build_operations_register_rows(
        [
            {
                "id": 1,
                "date": "2026-04-01",
                "operation_type": "расход",
                "description": "вода в офис",
                "amount": 1200,
                "payment_account": "ИП Каменский АБ",
            },
            {
                "id": 2,
                "date": "2026-04-02",
                "operation_type": "закупка",
                "description": "видеокарта",
                "amount": 45000,
                "expense_category": "GPU",
                "payment_account": "ИП Каменский АБ",
            },
        ]
    )

    assert rows[1][3] == "Внереализационные"
    assert rows[1][4] == "Офис"
    assert rows[1][5] == "Вода и кофе"
    assert rows[2][3] == "Себестоимость"
    assert rows[2][4] == "Комплектующие"
    assert rows[2][5] == "GPU"


def test_build_pl_rows_uses_weighted_total_margin():
    month_ops = {
        "2026-03": [
            {"operation_type": "продажа", "amount": 100000, "order_id": 10, "order_status": "closed"},
            {"operation_type": "закупка", "amount": 50000, "order_id": 10},
        ],
        "2026-04": [
            {"operation_type": "продажа", "amount": 10000, "order_id": 11, "order_status": "closed"},
            {"operation_type": "закупка", "amount": 9000, "order_id": 11},
        ],
    }

    rows = sheets.build_pl_rows(month_ops, selected_period="Все")
    margin_row = next(row for row in rows if row and row[0] == "Маржа %")

    # Weighted margin = (50000 + 1000) / (100000 + 10000) * 100
    assert round(margin_row[-1], 2) == round((51000 / 110000) * 100, 2)


def test_dashboard_and_pl_exclude_open_order_sales_but_keep_cash_receipts():
    month_ops = {
        "2026-04": [
            {"operation_type": "продажа", "amount": 100000, "order_id": 10, "order_status": "open"},
            {"operation_type": "предоплата", "amount": 30000, "order_id": 10, "order_status": "open"},
            {"operation_type": "закупка", "amount": 60000, "order_id": 10},
            {"operation_type": "расход", "amount": 5000, "expense_category": "Офис"},
        ]
    }

    pl_rows = sheets.build_pl_rows(month_ops, selected_period="2026-04")
    revenue_row = next(row for row in pl_rows if row and row[0] == "Выручка")
    cogs_row = next(row for row in pl_rows if row and row[0] == "Себестоимость")
    net_row = next(row for row in pl_rows if row and row[0] == "Чистая прибыль")
    assert revenue_row[-1] == 0.0
    assert cogs_row[-1] == 0.0
    assert net_row[-1] == -5000.0

    dashboard_rows, _, metric_row_map = sheets.build_dashboard_rows(month_ops, {}, selected_period="2026-04")
    dds_in_row = dashboard_rows[metric_row_map["dds_in"]]
    revenue_dashboard_row = dashboard_rows[metric_row_map["opiu_revenue"]]
    net_dashboard_row = dashboard_rows[metric_row_map["opiu_net"]]
    assert dds_in_row[-1] == 30000.0
    assert revenue_dashboard_row[-1] == 0.0
    assert net_dashboard_row[-1] == -5000.0


def test_build_specs_rows_contains_expected_columns():
    rows = sheets.build_specs_rows(
        [
            {
                "spec_document_id": 1,
                "version": 2,
                "spec_created_at": "2026-04-05 10:00:00",
                "order_id": 99,
                "order_phone": "+79990001122",
                "client_name": "Иванов",
                "item_index": 1,
                "component_name": "Процессор",
                "component_value": "Intel Core i5",
                "purchase_price": 15000,
                "item_status": "confirmed",
                "confidence": 0.92,
                "parse_status": "parsed",
                "source_file_name": "spec.docx",
            }
        ]
    )

    assert rows[0][0] == "Spec ID"
    assert rows[1][7] == "Процессор"
    assert rows[1][9] == 15000


def test_build_specs_review_rows_contains_reason_column():
    rows = sheets.build_specs_review_rows(
        [
            {
                "spec_document_id": 2,
                "version": 2,
                "spec_created_at": "2026-04-05 10:00:00",
                "order_id": 99,
                "order_phone": "+79990001122",
                "client_name": "Иванов",
                "item_index": 1,
                "component_name": "Видеокарта",
                "component_value": "RTX 5060",
                "purchase_price": None,
                "item_status": "unconfirmed",
                "confidence": 0.65,
                "parse_status": "manual_review",
                "source_file_name": "spec_v2.docx",
            }
        ]
    )

    assert rows[0][-1] == "Причина"
    assert "ручная проверка" in rows[1][-1].lower()


def test_build_data_quality_rows_highlights_missing_required_fields():
    rows = sheets.build_data_quality_rows(
        [
            {
                "id": 7,
                "date": "2026-04-20",
                "operation_type": "расход",
                "description": "Расход без счета",
                "amount": 1000,
                "payment_account": "",
                "expense_category": "",
                "expense_subcategory": "",
                "created_by": "99:Manager",
            }
        ]
    )

    assert rows[0][0] == "Контроль качества данных"
    assert any("Проблемных записей" == row[0] and row[2] == "Проблема" for row in rows if row)
    assert any("Не указан счет оплаты" in str(row[6]) for row in rows if len(row) > 6)


def test_no_proxy_http_client_disables_env_proxy():
    client = sheets.NoProxyHTTPClient(auth=None, session=requests.Session())

    assert client.session.trust_env is False
    assert client.session.proxies == {}


def test_open_client_uses_no_proxy_http_client(monkeypatch):
    artifacts_dir = sheets.config.DATA_DIR / "test_artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    creds_path = artifacts_dir / "sheet_credentials_test.json"
    creds_path.write_text("{}", encoding="utf-8")
    called = {}

    def fake_service_account(filename, http_client):
        called["filename"] = filename
        called["http_client"] = http_client
        return "client"

    monkeypatch.setattr(sheets.config, "GOOGLE_CREDS_PATH", str(creds_path))
    monkeypatch.setattr(sheets.gspread, "service_account", fake_service_account)

    result = sheets._open_client()

    assert result == "client"
    assert called["filename"] == str(creds_path)
    assert called["http_client"] is sheets.NoProxyHTTPClient
    creds_path.unlink(missing_ok=True)
