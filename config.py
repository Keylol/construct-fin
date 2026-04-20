"""Project configuration loaded from .env."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DOCUMENTS_DIR = Path(os.getenv("DOCUMENTS_PATH", str(DATA_DIR / "documents")))
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", str(DATA_DIR / "bot.db")))


def _parse_id_list(raw_value: str) -> list[int]:
    return [int(uid.strip()) for uid in str(raw_value or "").split(",") if uid.strip().isdigit()]


def _parse_csv_list(raw_value: str) -> list[str]:
    return [item.strip() for item in str(raw_value or "").split(",") if item.strip()]


# Telegram
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
MINIAPP_URL = os.getenv("MINIAPP_URL", "").strip()
ALLOWED_USER_IDS = _parse_id_list(os.getenv("ALLOWED_USER_IDS", ""))
OWNER_USER_IDS = _parse_id_list(os.getenv("OWNER_USER_IDS", ""))
OPERATOR_USER_IDS = _parse_id_list(os.getenv("OPERATOR_USER_IDS", ""))

OWNER_ONLY_COMMANDS = {"sheetsetup", "quality", "1100"}
DATA_WIPE_TRIGGER_CODE = os.getenv("DATA_WIPE_TRIGGER_CODE", "1100").strip() or "1100"
DATA_WIPE_PIN = os.getenv("DATA_WIPE_PIN", "0011").strip() or "0011"


def resolve_user_role(user_id: int) -> str | None:
    """Resolves role for Telegram user id."""
    if int(user_id) in OWNER_USER_IDS:
        return "owner"
    if int(user_id) in OPERATOR_USER_IDS:
        return "operator"
    if int(user_id) in ALLOWED_USER_IDS:
        return "owner"
    if not (ALLOWED_USER_IDS or OWNER_USER_IDS or OPERATOR_USER_IDS):
        # Open mode for local tests/dev when ids are not configured.
        return "owner"
    return None


def is_command_allowed(role: str, command: str) -> bool:
    """Checks whether command is allowed for role."""
    normalized_role = str(role or "").strip().lower()
    normalized_command = str(command or "").strip().lower()
    if not normalized_command:
        return True
    if normalized_role == "owner":
        return True
    if normalized_role == "operator":
        return normalized_command not in OWNER_ONLY_COMMANDS
    return False

# AI parser (OpenAI-compatible endpoint)
AI_API_KEY = os.getenv("AI_API_KEY", "").strip() or os.getenv("GEMINI_API_KEY", "").strip()
# Legacy alias kept so old code/tests/env names do not break.
GEMINI_API_KEY = AI_API_KEY
AI_BASE_URL = os.getenv("AI_BASE_URL", "https://api.ohmylama.com/v1")
AI_MODEL = os.getenv("AI_MODEL", "gpt-5.4-mini")
AI_MODEL_OPTIONS = _parse_csv_list(
    os.getenv(
        "AI_MODEL_OPTIONS",
        "gpt-5.4-mini,gpt-5.4,gpt-5-mini,claude-sonnet-4.6,gemini-2.5-flash",
    )
)
AI_RUNTIME_STATE_PATH = Path(os.getenv("AI_RUNTIME_STATE_PATH", str(DATA_DIR / "ai_runtime.json")))

# Google Sheets
GOOGLE_CREDS_PATH = os.getenv("GOOGLE_CREDS_PATH", str(DATA_DIR / "credentials.json"))
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID", "")
SPREADSHEET_TITLE = os.getenv("SPREADSHEET_TITLE", "ConstructPC Управленческий учет")
SPREADSHEET_SHARE_EMAIL = os.getenv("SPREADSHEET_SHARE_EMAIL", "")

EXPENSE_CATEGORIES = [
    "Комплектующие",
    "CPU",
    "GPU",
    "RAM",
    "SSD/HDD",
    "Материнская плата",
    "Охлаждение",
    "Блок питания",
    "Корпус",
    "Периферия",
    "Другое комплектующие",
    "Комплектующие (итог)",
    "Офис",
    "Аренда",
    "Зарплаты",
    "Интернет",
    "Банковские расходы",
    "Расходники",
    "Реклама",
    "Розыгрыши",
    "Налоги",
    "Доставка",
    "Развитие бизнеса",
]

MINIAPP_HIDDEN_EXPENSE_CATEGORIES = {
    "Комплектующие",
    "CPU",
    "GPU",
    "RAM",
    "SSD/HDD",
    "Материнская плата",
    "Охлаждение",
    "Блок питания",
    "Корпус",
    "Периферия",
    "Другое комплектующие",
    "Комплектующие (итог)",
}

MINIAPP_BUSINESS_EXPENSE_CATEGORIES = [
    item for item in EXPENSE_CATEGORIES if item not in MINIAPP_HIDDEN_EXPENSE_CATEGORIES
]

EXPENSE_SUBCATEGORIES: dict[str, list[str]] = {
    "Комплектующие": [
        "CPU",
        "GPU",
        "RAM",
        "SSD/HDD",
        "Материнская плата",
        "Охлаждение",
        "Блок питания",
        "Корпус",
        "Периферия",
        "Другое комплектующие",
        "Прочее",
    ],
    "Офис": ["Канцелярия", "Вода и кофе", "Хозтовары", "Интернет", "Прочее"],
    "Аренда": ["Офис", "Склад", "Коммунальные", "Прочее"],
    "Зарплаты": ["Оклад", "Премии", "Подрядчики", "Прочее"],
    "Интернет": ["Проводной", "Мобильный", "Прочее"],
    "Банковские расходы": ["Эквайринг", "Комиссии", "Обслуживание счета", "Прочее"],
    "Расходники": ["Упаковка", "Кабели и мелочи", "Прочее"],
    "Реклама": ["Таргет", "Контекст", "Маркетплейсы", "Прочее"],
    "Розыгрыши": ["Призы", "Реклама розыгрыша", "Прочее"],
    "Налоги": ["УСН/Налог на прибыль", "Страховые взносы", "Прочее"],
    "Доставка": ["К клиенту", "От поставщика", "Курьер", "Прочее"],
    "Развитие бизнеса": ["Софт/Сервисы", "Обучение", "Оборудование", "Прочее"],
}

COMMERCIAL_EXPENSE_CATEGORIES = {"Реклама", "Розыгрыши", "Доставка"}
NON_OPERATING_EXPENSE_CATEGORIES = {
    "Офис",
    "Аренда",
    "Зарплаты",
    "Развитие бизнеса",
    "Интернет",
    "Банковские расходы",
    "Налоги",
    "Расходники",
}

COMPONENT_CATEGORY_ALIASES = {
    "cpu": "CPU",
    "gpu": "GPU",
    "ram": "RAM",
    "ssd/hdd": "SSD/HDD",
    "материнская плата": "Материнская плата",
    "охлаждение": "Охлаждение",
    "блок питания": "Блок питания",
    "корпус": "Корпус",
    "периферия": "Периферия",
    "другое комплектующие": "Другое комплектующие",
    "комплектующие (итог)": "Другое комплектующие",
}

EXPENSE_CATEGORY_MARKERS: dict[str, tuple[str, ...]] = {
    "Офис": ("офис", "вода", "чай", "кофе", "канц", "бумага", "уборк", "хоз"),
    "Аренда": ("аренд",),
    "Зарплаты": ("зарплат", "оклад", "аванс сотруд", "преми"),
    "Интернет": ("интернет", "wifi", "wi-fi", "роутер", "связь"),
    "Банковские расходы": ("банк", "эквайринг", "комисси"),
    "Расходники": ("расходник", "упаковк", "кабель", "переходник"),
    "Реклама": ("реклам", "таргет", "контекст"),
    "Розыгрыши": ("розыгрыш", "приз"),
    "Налоги": ("налог", "взнос"),
    "Доставка": ("доставк", "курьер"),
    "Развитие бизнеса": ("развит", "обучен", "подписк", "сервис", "saas"),
}

EXPENSE_SUBCATEGORY_MARKERS: dict[tuple[str, str], tuple[str, ...]] = {
    ("Офис", "Канцелярия"): ("канц", "бумага", "ручк"),
    ("Офис", "Вода и кофе"): ("вода", "кофе", "чай"),
    ("Офис", "Интернет"): ("интернет", "wifi", "wi-fi"),
    ("Аренда", "Офис"): ("офис",),
    ("Аренда", "Склад"): ("склад",),
    ("Зарплаты", "Оклад"): ("оклад",),
    ("Зарплаты", "Премии"): ("преми",),
    ("Зарплаты", "Подрядчики"): ("подряд", "фриланс"),
    ("Банковские расходы", "Эквайринг"): ("эквайринг",),
    ("Банковские расходы", "Комиссии"): ("комисси",),
    ("Доставка", "К клиенту"): ("к клиент",),
    ("Доставка", "От поставщика"): ("от поставщ",),
    ("Доставка", "Курьер"): ("курьер",),
    ("Реклама", "Таргет"): ("таргет",),
    ("Реклама", "Контекст"): ("контекст",),
    ("Реклама", "Маркетплейсы"): ("wb", "wildberries", "ozon"),
    ("Развитие бизнеса", "Софт/Сервисы"): ("подписк", "saas", "crm", "сервис"),
    ("Развитие бизнеса", "Обучение"): ("курс", "обучен"),
    ("Развитие бизнеса", "Оборудование"): ("оборудован",),
}


def _normalize_component_category(raw_category: str) -> tuple[str | None, str | None]:
    subcategory = COMPONENT_CATEGORY_ALIASES.get(raw_category.strip().lower())
    if subcategory:
        return "Комплектующие", subcategory
    return None, None


def detect_expense_category(text: str) -> str | None:
    """Detects normalized expense category from free text."""
    lowered = str(text or "").strip().lower()
    if not lowered:
        return None

    for category, markers in EXPENSE_CATEGORY_MARKERS.items():
        if any(marker in lowered for marker in markers):
            return category
    if any(token in lowered for token in ("комплект", "видеокарт", "процессор", "ssd", "ram", "материн")):
        return "Комплектующие"
    return None


def normalize_expense_taxonomy(
    *,
    category: str | None,
    subcategory: str | None = None,
    description: str | None = None,
) -> tuple[str | None, str | None]:
    """
    Normalizes (category, subcategory) into approved taxonomy values.

    Returns tuple: (category, subcategory).
    """
    raw_category = str(category or "").strip()
    raw_subcategory = str(subcategory or "").strip()
    description_text = str(description or "").strip()

    normalized_category: str | None = None
    normalized_subcategory: str | None = None

    component_category, component_sub = _normalize_component_category(raw_category)
    if component_category:
        normalized_category = component_category
        normalized_subcategory = component_sub
    elif raw_category in EXPENSE_CATEGORIES:
        if raw_category in EXPENSE_SUBCATEGORIES:
            normalized_category = raw_category
        elif raw_category == "Комплектующие (итог)":
            normalized_category = "Комплектующие"
            normalized_subcategory = "Другое комплектующие"
        else:
            normalized_category = raw_category

    if not normalized_category:
        normalized_category = detect_expense_category(description_text)

    if normalized_category and not normalized_subcategory:
        allowed_subcategories = EXPENSE_SUBCATEGORIES.get(normalized_category, [])
        if raw_subcategory in allowed_subcategories:
            normalized_subcategory = raw_subcategory
        elif raw_subcategory:
            raw_sub = raw_subcategory.lower()
            normalized_subcategory = next(
                (item for item in allowed_subcategories if item.lower() == raw_sub),
                None,
            )

    if normalized_category and not normalized_subcategory:
        lowered = description_text.lower()
        for (category_name, subcategory_name), markers in EXPENSE_SUBCATEGORY_MARKERS.items():
            if category_name != normalized_category:
                continue
            if any(marker in lowered for marker in markers):
                normalized_subcategory = subcategory_name
                break

    if normalized_category and not normalized_subcategory:
        allowed_subcategories = EXPENSE_SUBCATEGORIES.get(normalized_category, [])
        if "Прочее" in allowed_subcategories:
            normalized_subcategory = "Прочее"
        elif allowed_subcategories:
            normalized_subcategory = allowed_subcategories[0]

    return normalized_category, normalized_subcategory


def expense_block(category: str | None) -> str | None:
    """Returns expense block name for analytics."""
    normalized = str(category or "").strip()
    if not normalized:
        return None
    if normalized == "Комплектующие":
        return "Себестоимость"
    if normalized in COMMERCIAL_EXPENSE_CATEGORIES:
        return "Коммерческие"
    return "Внереализационные"

OPERATION_TYPES = [
    "продажа",
    "закупка",
    "предоплата",
    "постоплата",
    "расход",
]
ORDER_OPERATION_TYPES = ["продажа", "закупка", "предоплата", "постоплата"]
SALE_TYPES = ["Сборка", "Сервис"]
INCOME_CHANNELS = ["Онлайн", "Наличные"]

PAYMENT_SOURCES = ["корп", "физ"]
PAYMENT_METHODS = ["карта", "наличные", "перевод"]
SUPPLIERS = ["ДНС", "Wildberries", "Ozon", "Онлайн Трейд", "Авито"]
DOCUMENT_TYPES = ["чек", "гарантия", "спецификация", "другое"]
SUPPORTED_DOCUMENT_EXTENSIONS = {".pdf", ".doc", ".docx"}
DEFAULT_BUSINESS_DIRECTION = "Розница"
DEFAULT_PAYMENT_ACCOUNTS = [
    "ИП Каменский АБ",
    "Каменский ВБ",
    "Антропов ВБ",
    "Каменский ОБ",
    "Наличные",
]

PAYMENT_ACCOUNT_ALIASES = {
    "ип каменский аб": "ИП Каменский АБ",
    "ип аб": "ИП Каменский АБ",
    "каменский аб": "ИП Каменский АБ",
    "кам аб": "ИП Каменский АБ",
    "каменский вб": "Каменский ВБ",
    "кам вб": "Каменский ВБ",
    "вб каменский": "Каменский ВБ",
    "антропов вб": "Антропов ВБ",
    "ант вб": "Антропов ВБ",
    "вб антропов": "Антропов ВБ",
    "каменский об": "Каменский ОБ",
    "кам об": "Каменский ОБ",
    "об каменский": "Каменский ОБ",
    "нал": "Наличные",
    "наличные": "Наличные",
    # legacy names
    "ип каменский корп": "ИП Каменский АБ",
    "каменский корп": "ИП Каменский АБ",
    "wb каменский физ": "Каменский ВБ",
    "каменский физ": "Каменский ВБ",
    "ип дерябин корп": "Каменский ОБ",
    "дерябин корп": "Каменский ОБ",
    "wb антропов физ": "Антропов ВБ",
    "антропов физ": "Антропов ВБ",
}

LEGACY_PAYMENT_ACCOUNT_MAP = {
    "ИП Каменский корп": "ИП Каменский АБ",
    "WB Каменский физ": "Каменский ВБ",
    "ИП Дерябин корп": "Каменский ОБ",
    "WB Антропов физ": "Антропов ВБ",
}

DEFAULT_PURCHASE_ACCOUNT = "ИП Каменский АБ"
DEFAULT_INCOME_ACCOUNT = "ИП Каменский АБ"


def normalize_payment_account(value: str | None) -> str | None:
    """Normalizes raw payment account to one of supported accounts."""
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw in DEFAULT_PAYMENT_ACCOUNTS:
        return raw
    if raw in LEGACY_PAYMENT_ACCOUNT_MAP:
        return LEGACY_PAYMENT_ACCOUNT_MAP[raw]
    lowered = raw.lower()
    if lowered in PAYMENT_ACCOUNT_ALIASES:
        return PAYMENT_ACCOUNT_ALIASES[lowered]
    for alias, canonical in PAYMENT_ACCOUNT_ALIASES.items():
        if alias in lowered:
            return canonical
    return None


def default_payment_account_for_operation(operation_type: str | None) -> str | None:
    normalized = str(operation_type or "").strip().lower()
    if normalized == "закупка":
        return DEFAULT_PURCHASE_ACCOUNT
    if normalized in {"продажа", "предоплата", "постоплата", "оплата"}:
        return DEFAULT_INCOME_ACCOUNT
    return None


def payment_source_for_account(payment_account: str | None) -> str:
    normalized = normalize_payment_account(payment_account) or ""
    if normalized in {"ИП Каменский АБ", "Каменский ОБ"}:
        return "корп"
    return "физ"


def payment_method_for_account(payment_account: str | None, text: str = "") -> str:
    normalized = normalize_payment_account(payment_account) or ""
    lowered = str(text or "").lower()
    if normalized == "Наличные" or "налич" in lowered:
        return "наличные"
    if "сбп" in lowered or "перевод" in lowered:
        return "перевод"
    return "карта"


def validate_config() -> list[str]:
    """Returns list of blocking configuration errors."""
    errors: list[str] = []
    if not TELEGRAM_BOT_TOKEN:
        errors.append("TELEGRAM_BOT_TOKEN не задан в .env")
    if not (ALLOWED_USER_IDS or OWNER_USER_IDS or OPERATOR_USER_IDS):
        errors.append("Укажите ALLOWED_USER_IDS или OWNER_USER_IDS/OPERATOR_USER_IDS в .env")
    if DATA_WIPE_PIN == DATA_WIPE_TRIGGER_CODE:
        errors.append("DATA_WIPE_PIN и DATA_WIPE_TRIGGER_CODE не должны совпадать")
    return errors
