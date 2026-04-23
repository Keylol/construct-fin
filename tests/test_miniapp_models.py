from miniapp_api.app.models import OrderStatus, UserRole


def test_user_role_enum_uses_lowercase_database_values():
    assert UserRole("owner") is UserRole.owner
    assert UserRole.OWNER is UserRole.owner
    assert UserRole.owner.name == "owner"
    assert UserRole.owner.value == "owner"


def test_order_status_enum_uses_lowercase_database_values():
    assert OrderStatus("open") is OrderStatus.open
    assert OrderStatus.OPEN is OrderStatus.open
    assert OrderStatus.open.name == "open"
    assert OrderStatus.open.value == "open"
