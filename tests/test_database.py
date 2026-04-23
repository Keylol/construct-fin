import pytest

from bot.services import database


@pytest.mark.asyncio
async def test_get_or_create_client_by_name_is_idempotent(isolated_db):
    first_id = await database.get_or_create_client_by_name("Иван Иванов")
    second_id = await database.get_or_create_client_by_name("иван иванов")

    assert first_id == second_id
    clients = await database.get_all_clients()
    assert len(clients) == 1


@pytest.mark.asyncio
async def test_get_or_create_client_by_phone_returns_same_client(isolated_db):
    client_id_1, created_1 = await database.get_or_create_client_by_phone(
        phone="+7 (999) 123-45-67",
        full_name="Петров",
    )
    client_id_2, created_2 = await database.get_or_create_client_by_phone(
        phone="89991234567",
        full_name="Петров П.",
    )

    assert created_1 is True
    assert created_2 is False
    assert client_id_1 == client_id_2

    client = await database.find_client_by_phone("+79991234567")
    assert client is not None
    assert client["phone"] == "+79991234567"


@pytest.mark.asyncio
async def test_order_operations_and_totals(isolated_db):
    client_id, _ = await database.get_or_create_client_by_phone("+79990001122", full_name="Иванов")
    order_id = await database.create_order(
        client_id=client_id,
        order_phone="+79990001122",
        opened_by="1:tester",
        sale_type="Сборка",
    )

    await database.add_operation(
        date="2026-04-01",
        operation_type="закупка",
        description="Закупка комплектующих",
        amount=60000.0,
        created_by="1:tester",
        client_id=client_id,
        order_id=order_id,
        order_phone="+79990001122",
        payment_account="ИП Каменский АБ",
    )
    await database.add_operation(
        date="2026-04-02",
        operation_type="продажа",
        description="Продажа сборки",
        amount=100000.0,
        created_by="1:tester",
        client_id=client_id,
        order_id=order_id,
        order_phone="+79990001122",
        sale_type="Сборка",
        payment_account="Каменский ВБ",
    )

    totals = await database.get_order_totals(order_id)
    assert totals["income_total"] == 100000.0
    assert totals["cogs_total"] == 60000.0
    assert totals["opex_total"] == 0.0
    assert totals["operations_count"] == 2


@pytest.mark.asyncio
async def test_get_all_operations_for_export_returns_order_fields(isolated_db):
    client_id, _ = await database.get_or_create_client_by_phone("+79994445566", full_name="Сидоров")
    order_id = await database.create_order(
        client_id=client_id,
        order_phone="+79994445566",
        opened_by="1:tester",
        sale_type="Сервис",
    )
    await database.add_operation(
        date="2026-04-03",
        operation_type="продажа",
        description="Сервис",
        amount=15000.0,
        created_by="1:tester",
        client_id=client_id,
        order_id=order_id,
        order_phone="+79994445566",
        sale_type="Сервис",
        income_channel="Наличные",
        payment_account="Наличные",
    )

    operations = await database.get_all_operations_for_export()

    assert len(operations) == 1
    assert operations[0]["client_name"] == "Сидоров"
    assert operations[0]["order_sale_type"] == "Сервис"
    assert operations[0]["order_phone"] == "+79994445566"


@pytest.mark.asyncio
async def test_recognition_log_written_and_readable(isolated_db):
    log_id = await database.add_recognition_log(
        source_text="продажа ПК 120000",
        created_by="1:tester",
        status="saved",
        parser_mode="fallback",
        parsed_payload='{"amount":120000}',
        final_payload='{"amount":120000}',
        correction_text=None,
    )
    assert log_id > 0

    logs = await database.get_recognition_logs(limit=10)
    assert len(logs) == 1
    assert logs[0]["status"] == "saved"
    assert logs[0]["parser_mode"] == "fallback"


@pytest.mark.asyncio
async def test_delete_operation_and_recent_list(isolated_db):
    op_id = await database.add_operation(
        date="2026-04-05",
        operation_type="расход",
        description="Тестовый расход",
        amount=1000.0,
        created_by="1:tester",
        payment_account="Каменский ВБ",
    )
    recent_before = await database.list_recent_operations(limit=5)
    assert any(row["id"] == op_id for row in recent_before)

    deleted = await database.delete_operation(op_id)
    assert deleted is True

    op = await database.get_operation_by_id(op_id)
    assert op is None


@pytest.mark.asyncio
async def test_delete_order_if_empty_removes_order_and_unused_client(isolated_db):
    client_id, _ = await database.get_or_create_client_by_phone("+79995556677", full_name="Тест")
    order_id = await database.create_order(
        client_id=client_id,
        order_phone="+79995556677",
        opened_by="1:tester",
    )

    result = await database.delete_order_if_empty(order_id)

    assert result["deleted"] is True
    assert result["deleted_client"] is True
    assert await database.get_order_by_id(order_id) is None
    assert await database.find_client_by_phone("+79995556677") is None


@pytest.mark.asyncio
async def test_delete_order_if_empty_blocks_non_empty_order(isolated_db):
    client_id, _ = await database.get_or_create_client_by_phone("+79995550000", full_name="Тест2")
    order_id = await database.create_order(
        client_id=client_id,
        order_phone="+79995550000",
        opened_by="1:tester",
    )
    await database.add_operation(
        date="2026-04-06",
        operation_type="продажа",
        description="Продажа",
        amount=10000.0,
        created_by="1:tester",
        client_id=client_id,
        order_id=order_id,
    )

    result = await database.delete_order_if_empty(order_id)

    assert result["deleted"] is False
    assert result["reason"] == "not_empty"
    assert result["operations_count"] == 1
