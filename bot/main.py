"""Entry point for ConstructPC Telegram bot."""

from __future__ import annotations

import logging
import os
import re
import sys
from functools import wraps
from pathlib import Path

import httpx
from telegram import BotCommand, KeyboardButton, MenuButtonWebApp, ReplyKeyboardMarkup, Update, WebAppInfo
from telegram.error import Conflict, NetworkError
from telegram.request import HTTPXRequest
from telegram.ext import Application, CommandHandler, MessageHandler, filters

import config
from bot.handlers.documents import handle_document
from bot.handlers.messages import (
    ACTIVE_CLIENT_ID_KEY,
    ACTIVE_ORDER_ID_KEY,
    ACTIVE_ORDER_PHONE_KEY,
    queue_delete_confirmation,
    handle_text_message,
)
from bot.handlers.reports import handle_report_command
from bot.services.database import (
    add_audit_log,
    close_order,
    create_order,
    get_last_operation,
    get_operation_by_id,
    get_or_create_client_by_phone,
    get_order_by_id,
    get_order_totals,
    init_db,
    list_recent_operations,
    normalize_phone,
)
from bot.services.quality_report import build_quality_report
from bot.services.sheets import setup_management_spreadsheet

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)
LOCK_FILE_PATH = config.DATA_DIR / "bot.lock"
RUNTIME_MINIAPP_URL_PATH = config.DATA_DIR / "miniapp_tunnel_url.txt"


def _telegram_request() -> HTTPXRequest:
    """Builds Telegram transport using the working network mode for Telegram."""

    return HTTPXRequest(httpx_kwargs=_detect_telegram_httpx_kwargs())


def _detect_telegram_httpx_kwargs() -> dict[str, object]:
    """Chooses the Telegram transport mode that works in the current environment."""

    override = str(os.getenv("TELEGRAM_TRUST_ENV", "auto")).strip().lower()
    if override in {"0", "false", "no"}:
        logger.info("Telegram transport override selected: trust_env=False")
        return {"trust_env": False}
    if override in {"1", "true", "yes"}:
        logger.info("Telegram transport override selected: trust_env=True")
        return {"trust_env": True}

    token = str(config.TELEGRAM_BOT_TOKEN or "").strip()
    if not token:
        return {"trust_env": False}

    test_url = f"https://api.telegram.org/bot{token}/getMe"
    last_error = None

    for trust_env in (True, False):
        try:
            with httpx.Client(timeout=httpx.Timeout(8.0, connect=5.0), trust_env=trust_env) as client:
                response = client.get(test_url)
            if response.status_code == 200:
                logger.info("Telegram transport auto-selected trust_env=%s", trust_env)
                return {"trust_env": trust_env}
            last_error = RuntimeError(f"Unexpected Telegram status {response.status_code}")
        except Exception as exc:
            last_error = exc
            logger.warning("Telegram preflight failed with trust_env=%s: %s", trust_env, exc)

    logger.warning("Telegram preflight failed in both modes, falling back to trust_env=True: %s", last_error)
    return {"trust_env": True}


class _TelegramTokenRedactingFilter(logging.Filter):
    """Redacts Telegram bot token fragments in log messages."""

    _token_pattern = re.compile(r"(https://api\.telegram\.org/bot)([^/\s]+)")

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted = self._token_pattern.sub(r"\1<redacted>", message)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


_root_logger = logging.getLogger()
for _handler in _root_logger.handlers:
    _handler.addFilter(_TelegramTokenRedactingFilter())

# Avoid verbose transport logs that can contain request URLs.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def _user_signature(user) -> str:
    return f"{user.id}:{user.first_name}"


def _extract_command_name(update: Update) -> str:
    text = str((getattr(update.message, "text", "") if update.message else "") or "").strip()
    if not text.startswith("/"):
        return ""
    return text.split()[0][1:].split("@")[0].lower()


def _get_runtime_miniapp_url() -> str:
    """Returns the live Mini App URL, preferring the tunnel runtime file."""

    try:
        runtime_url = Path(RUNTIME_MINIAPP_URL_PATH).read_text(encoding="utf-8").strip()
    except OSError:
        runtime_url = ""
    return runtime_url or str(config.MINIAPP_URL or "").strip()


async def _safe_audit_log(
    *,
    event_type: str,
    user,
    role: str | None,
    command_name: str | None = None,
    details: str | None = None,
):
    try:
        await add_audit_log(
            event_type,
            actor_user_id=int(user.id) if user else None,
            actor_name=(user.first_name if user else None),
            actor_role=role,
            command_name=command_name,
            details=details,
        )
    except Exception:
        logger.warning("Could not append audit log (%s)", event_type, exc_info=True)


def _current_role(update: Update) -> str:
    return config.resolve_user_role(update.effective_user.id) or ""


def check_user_access(func):
    """Allows bot access only for configured users or open local dev mode."""

    @wraps(func)
    async def wrapper(update: Update, context):
        user = update.effective_user
        user_id = int(user.id)

        role = config.resolve_user_role(user_id)
        if not role:
            logger.warning("Access denied for user: %s", user_id)
            await _safe_audit_log(
                event_type="access_denied",
                user=user,
                role=None,
                command_name=_extract_command_name(update),
                details="not_in_allowlist",
            )
            if update.message:
                await update.message.reply_text(
                    "У вас нет доступа к этому боту.\n"
                    f"Ваш Telegram ID: {user_id}"
                )
            return

        command_name = _extract_command_name(update)
        if command_name and not config.is_command_allowed(role, command_name):
            await _safe_audit_log(
                event_type="command_denied",
                user=user,
                role=role,
                command_name=command_name,
                details="role_restriction",
            )
            if update.message:
                await update.message.reply_text(
                    "Эта команда доступна только роли owner."
                )
            return

        context.user_data["user_role"] = role
        return await func(update, context)

    return wrapper


def _acquire_single_instance_lock():
    LOCK_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    lock_file = open(LOCK_FILE_PATH, "a+", encoding="utf-8")
    try:
        if sys.platform == "win32":
            import msvcrt

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock_file.close()
        return None

    lock_file.seek(0)
    lock_file.truncate()
    lock_file.write(str(os.getpid()))
    lock_file.flush()
    return lock_file


def _release_single_instance_lock(lock_file):
    if not lock_file:
        return
    try:
        if sys.platform == "win32":
            import msvcrt

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    except OSError:
        logger.warning("Could not release bot lock file cleanly.", exc_info=True)
    finally:
        lock_file.close()


@check_user_access
async def cmd_start(update: Update, context):
    user = update.effective_user
    await update.message.reply_text(
        f"Привет, {user.first_name}!\n\n"
        "Это бот управленческого учета ConstructPC.\n"
        "Работаем без кнопок: пишете текст, бот распознает операцию и мягко просит уточнение только при необходимости.\n\n"
        "Ключевые команды:\n"
        "/order +79991234567 Иванов Иван — открыть/создать карточку и заказ\n"
        "/card — показать активный заказ\n"
        "/closeorder — закрыть активный заказ\n"
        "/recent — последние операции\n"
        "/delete <id|last> — удалить операцию\n"
        "/report — текстовые отчеты\n"
        "/sheetsetup — синхронизация Google Sheets\n"
        "/help — подробная справка"
    )


@check_user_access
async def cmd_help(update: Update, context):
    await update.message.reply_text(
        "Как пользоваться:\n\n"
        "1) Откройте заказ: /order +79991234567 Иванов Иван\n"
        "2) Пишите операции обычным текстом.\n"
        "Примеры:\n"
        "- купил видеокарту 42000 у DNS с ИП Каменский АБ\n"
        "- продал сборку 99000 по заказу +79991234567\n"
        "- расход аренда 50000\n\n"
        "3) Бот покажет короткую карточку и попросит подтверждение:\n"
        "- ок\n"
        "- исправь сумму 55000\n"
        "- исправь счет Каменский ВБ\n\n"
        "Спецификации:\n"
        "- загрузите DOCX/PDF документом с подписью: `спецификация заказ`\n"
        "- если уже есть спецификация по заказу: добавьте `новая версия` или `замени`\n"
        "- бот извлечет комплектующие, попросит закупку по каждой позиции и предложит автосоздание продажи\n\n"
        "4) Если запись нужно удалить:\n"
        "- /recent\n"
        "- /delete 123\n"
        "- /delete last\n\n"
        "5) Качество распознавания и подсказки для промпта:\n"
        "- /quality\n"
        "- /quality 14\n\n"
        "6) Закройте заказ: /closeorder\n\n"
        "Документы:\n"
        "Прикрепляйте только PDF/DOC/DOCX, пока открыт заказ."
    )


@check_user_access
async def cmd_app(update: Update, context):
    miniapp_url = _get_runtime_miniapp_url()
    if not miniapp_url:
        await update.message.reply_text(
            "Mini App URL пока не настроен.\n"
            "Добавьте MINIAPP_URL в .env и перезапустите бота."
        )
        return

    keyboard = [[KeyboardButton(text="Открыть Mini App", web_app=WebAppInfo(url=miniapp_url))]]
    markup = ReplyKeyboardMarkup(keyboard=keyboard, resize_keyboard=True)
    await update.message.reply_text(
        "Откройте Mini App кнопкой ниже.",
        reply_markup=markup,
    )


@check_user_access
async def cmd_order(update: Update, context):
    if not context.args:
        await update.message.reply_text("Формат: /order +79991234567 Иванов Иван")
        return

    phone = normalize_phone(context.args[0])
    if not phone:
        await update.message.reply_text("Не вижу валидный телефон. Пример: /order +79991234567 Иванов Иван")
        return

    full_name = " ".join(context.args[1:]).strip() or None
    user = update.effective_user
    created_by = f"{user.id}:{user.first_name}"
    username = f"@{user.username}" if user.username else None

    client_id, created = await get_or_create_client_by_phone(
        phone=phone,
        full_name=full_name,
        telegram_username=username,
        created_by=created_by,
    )
    order_id = await create_order(
        client_id=client_id,
        order_phone=phone,
        opened_by=created_by,
        sale_type="Сборка",
    )

    context.user_data[ACTIVE_ORDER_ID_KEY] = order_id
    context.user_data[ACTIVE_CLIENT_ID_KEY] = client_id
    context.user_data[ACTIVE_ORDER_PHONE_KEY] = phone

    created_text = "Создана новая карточка клиента." if created else "Открыта существующая карточка клиента."
    await update.message.reply_text(
        f"{created_text}\n"
        f"Активный заказ: #{order_id}\n"
        f"Телефон заказа: {phone}\n\n"
        "Теперь просто пишите операции текстом."
    )


@check_user_access
async def cmd_closeorder(update: Update, context):
    order_id = context.user_data.get(ACTIVE_ORDER_ID_KEY)
    if not order_id:
        await update.message.reply_text("Сейчас нет активного заказа.")
        return

    user = update.effective_user
    closed_by = f"{user.id}:{user.first_name}"
    closed = await close_order(int(order_id), closed_by)

    context.user_data.pop(ACTIVE_ORDER_ID_KEY, None)
    context.user_data.pop(ACTIVE_CLIENT_ID_KEY, None)
    context.user_data.pop(ACTIVE_ORDER_PHONE_KEY, None)

    if closed:
        await update.message.reply_text(f"Заказ #{order_id} закрыт.")
    else:
        await update.message.reply_text("Заказ уже был закрыт или не найден.")


@check_user_access
async def cmd_card(update: Update, context):
    order_id = context.user_data.get(ACTIVE_ORDER_ID_KEY)
    if not order_id:
        await update.message.reply_text("Нет активного заказа. Откройте: /order +79991234567")
        return

    order = await get_order_by_id(int(order_id))
    if not order:
        await update.message.reply_text("Не нашел активный заказ. Откройте заново через /order.")
        return

    totals = await get_order_totals(int(order_id))
    profit = totals["income_total"] - totals["cogs_total"] - totals["opex_total"]
    await update.message.reply_text(
        f"Карточка заказа #{order['id']}\n"
        f"Телефон: {order['order_phone']}\n"
        f"Клиент: {order.get('client_name') or '-'}\n"
        f"Статус: {order['status']}\n"
        f"Тип продажи: {order.get('sale_type') or 'Сборка'}\n\n"
        f"Доход: {totals['income_total']:,.0f} ₽\n"
        f"Себестоимость: {totals['cogs_total']:,.0f} ₽\n"
        f"OPEX: {totals['opex_total']:,.0f} ₽\n"
        f"Итог: {profit:,.0f} ₽\n"
        f"Операций: {totals['operations_count']}"
    )


def _format_recent_operations(rows: list[dict]) -> str:
    lines = ["Последние операции:"]
    for row in rows:
        lines.append(
            f"#{row['id']} | {row['date']} | {row['operation_type']} | "
            f"{row['amount']:,.0f} ₽ | {row['description']}"
        )
    return "\n".join(lines)


@check_user_access
async def cmd_recent(update: Update, context):
    role = _current_role(update)
    user = update.effective_user
    created_by = _user_signature(user)
    rows = await list_recent_operations(
        limit=10,
        created_by=(None if role == "owner" else created_by),
    )
    if not rows:
        await update.message.reply_text("У вас пока нет операций.")
        return
    await update.message.reply_text(_format_recent_operations(rows))


@check_user_access
async def cmd_delete(update: Update, context):
    """
    Final delete handler:
    always asks for text confirmation before actual delete.
    """
    role = _current_role(update)
    user = update.effective_user
    created_by = _user_signature(user)

    if not context.args:
        rows = await list_recent_operations(
            limit=5,
            created_by=(None if role == "owner" else created_by),
        )
        hint = _format_recent_operations(rows) if rows else "У вас пока нет операций."
        await update.message.reply_text(
            "Формат: /delete <id> или /delete last\n\n"
            f"{hint}"
        )
        return

    arg = context.args[0].strip().lower()
    if arg in {"last", "последняя"}:
        operation = await get_last_operation(created_by=None if role == "owner" else created_by)
        if not operation:
            await update.message.reply_text("Не нашел вашу последнюю операцию.")
            return
        operation_id = int(operation["id"])
    else:
        if not arg.isdigit():
            await update.message.reply_text("Нужен числовой ID. Пример: /delete 123")
            return
        operation_id = int(arg)
        if role != "owner":
            operation = await get_operation_by_id(operation_id)
            if not operation:
                await update.message.reply_text(f"Операция #{operation_id} не найдена.")
                return
            if str(operation.get("created_by") or "") != created_by:
                await update.message.reply_text("Можно удалять только собственные операции.")
                await _safe_audit_log(
                    event_type="delete_denied",
                    user=user,
                    role=role,
                    command_name="delete",
                    details=f"target_id={operation_id}",
                )
                return

    await queue_delete_confirmation(
        update,
        context,
        target_id=operation_id,
        requested_by=user.id,
    )


@check_user_access
async def cmd_report_wrapper(update: Update, context):
    role = _current_role(update)
    user = update.effective_user
    created_by = None if role == "owner" else _user_signature(user)
    await handle_report_command(update, context, created_by=created_by)


def _split_long_message(text: str, chunk_size: int = 3500) -> list[str]:
    if len(text) <= chunk_size:
        return [text]
    chunks: list[str] = []
    current = []
    current_len = 0
    for line in text.splitlines(keepends=True):
        if current_len + len(line) > chunk_size and current:
            chunks.append("".join(current))
            current = [line]
            current_len = len(line)
        else:
            current.append(line)
            current_len += len(line)
    if current:
        chunks.append("".join(current))
    return chunks


@check_user_access
async def cmd_quality(update: Update, context):
    days = 7
    if context.args and context.args[0].isdigit():
        days = int(context.args[0])

    message = await update.message.reply_text("Собираю журнал качества распознавания...")
    try:
        report = await build_quality_report(days=days)
    except Exception as exc:
        logger.error("Quality report failed: %s", exc, exc_info=True)
        await message.edit_text(f"Не удалось собрать quality-отчет: {type(exc).__name__}: {exc}")
        return

    chunks = _split_long_message(report)
    await message.edit_text(chunks[0])
    for chunk in chunks[1:]:
        await update.message.reply_text(chunk)


@check_user_access
async def cmd_sheetsetup(update: Update, context):
    message = await update.message.reply_text("Настраиваю Google Sheets и синхронизирую данные...")
    try:
        result = await setup_management_spreadsheet()
    except FileNotFoundError:
        await message.edit_text(
            "Не нашел файл сервисного аккаунта Google. Проверьте GOOGLE_CREDS_PATH в .env."
        )
        return
    except Exception as exc:
        logger.error("Sheet setup failed: %s", exc, exc_info=True)
        error_name = type(exc).__name__
        error_text = str(exc).strip() or "без текста ошибки"
        if "invalid_grant" in error_text.lower() and ("iat" in error_text.lower() or "exp" in error_text.lower()):
            await message.edit_text(
                "Google Sheets не настроился из-за времени на компьютере.\n"
                "Проверьте дату/время/часовой пояс Windows и включите авто-синхронизацию времени.\n"
                "После синхронизации времени повторите /sheetsetup."
            )
            return
        await message.edit_text(
            "Не удалось настроить Google Sheets.\n"
            f"{error_name}: {error_text[:300]}"
        )
        return

    created_text = "Создал новую книгу." if result.get("created") else "Подключился к существующей книге."
    await message.edit_text(
        f"{created_text}\n"
        f"Таблица готова: {result.get('spreadsheet_url')}\n"
        "Листы синхронизированы: помесячные Журнал расходов/Доход/Итог, Specs, Specs Review, "
        "Справочник расходов и Дашборд."
    )


@check_user_access
async def cmd_wipe_code(update: Update, context):
    """
    Numeric owner command routed through text handler:
    /1100 -> PIN flow in message handler.
    """
    await handle_text_message(update, context)


@check_user_access
async def text_message_wrapper(update: Update, context):
    await handle_text_message(update, context)


@check_user_access
async def document_wrapper(update: Update, context):
    await handle_document(update, context)


async def post_init(application: Application):
    await init_db()
    logger.info("Database initialized")

    commands = [
        BotCommand("start", "Начать работу"),
        BotCommand("app", "Открыть Mini App"),
        BotCommand("order", "Открыть заказ"),
        BotCommand("card", "Показать активный заказ"),
        BotCommand("closeorder", "Закрыть активный заказ"),
        BotCommand("recent", "Последние операции"),
        BotCommand("delete", "Удалить операцию"),
        BotCommand("quality", "Качество распознавания"),
        BotCommand("report", "Отчеты"),
        BotCommand("sheetsetup", "Настроить Google Sheets"),
        BotCommand("help", "Справка"),
    ]
    try:
        await application.bot.set_my_commands(commands)
        logger.info("Bot commands configured")
    except Exception:
        logger.warning("Could not configure bot commands during startup.", exc_info=True)

    miniapp_url = _get_runtime_miniapp_url()
    if miniapp_url:
        try:
            await application.bot.set_chat_menu_button(
                menu_button=MenuButtonWebApp(text="Mini App", web_app=WebAppInfo(url=miniapp_url))
            )
            logger.info("Mini App menu button configured")
        except Exception:
            logger.warning("Could not configure Mini App menu button during startup.", exc_info=True)

    try:
        bot_info = await application.bot.get_me()
        logger.info("Bot started: @%s", bot_info.username)
    except Exception:
        logger.warning("Could not fetch bot info during startup.", exc_info=True)


def main():
    import asyncio
    import warnings

    warnings.filterwarnings("ignore", category=DeprecationWarning)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    if sys.platform == "win32":
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        except Exception:
            pass

    errors = config.validate_config()
    if errors:
        for err in errors:
            logger.error(err)
        logger.error("Заполните .env (можно начать с .env.example)")
        sys.exit(1)

    lock_file = _acquire_single_instance_lock()
    if not lock_file:
        logger.error("Уже запущен другой экземпляр бота. Остановите его и повторите запуск.")
        sys.exit(1)

    app = (
        Application.builder()
        .token(config.TELEGRAM_BOT_TOKEN)
        .request(_telegram_request())
        .get_updates_request(_telegram_request())
        .post_init(post_init)
        .build()
    )

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("app", cmd_app))
    app.add_handler(CommandHandler("order", cmd_order))
    app.add_handler(CommandHandler("card", cmd_card))
    app.add_handler(CommandHandler("closeorder", cmd_closeorder))
    app.add_handler(CommandHandler("recent", cmd_recent))
    app.add_handler(CommandHandler("delete", cmd_delete))
    app.add_handler(CommandHandler("quality", cmd_quality))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("report", cmd_report_wrapper))
    app.add_handler(CommandHandler("sheetsetup", cmd_sheetsetup))
    app.add_handler(CommandHandler("1100", cmd_wipe_code))
    app.add_handler(MessageHandler(filters.Document.ALL, document_wrapper))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_message_wrapper))

    try:
        logger.info("Starting polling...")
        app.run_polling(allowed_updates=Update.ALL_TYPES)
    except Conflict:
        logger.error("Bot stopped: another instance is already polling updates.")
        logger.error("Close the duplicate process and start again.")
        sys.exit(1)
    except NetworkError as exc:
        logger.error("Bot stopped: network error while connecting to Telegram API: %s", exc)
        logger.error("Check internet/proxy settings and try again.")
        sys.exit(1)
    finally:
        _release_single_instance_lock(lock_file)


if __name__ == "__main__":
    main()
