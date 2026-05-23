# Telegram-настройка для Construct v6

Бот **`@ConstructFinance_bot`** уже создан и настроен в `@BotFather` для v5.2.1. Для v6 переиспользуем его — ничего нового создавать не надо.

## Текущая конфигурация бота

| Параметр | Значение | Где смотреть/менять |
|---|---|---|
| Token (актуальный, после ротации 2026-05-03) | `<REDACTED-BOT-TOKEN>` | `.env` локально, `gh secret list -R Keylol/construct-fin` на CI, `/srv/construct/app/.env` на VPS |
| Username | `ConstructFinance_bot` | `@BotFather → Bot Settings` |
| Login Widget domain | `aleksandrantropov.ru` (вкл. поддомены `*.aleksandrantropov.ru`) | `@BotFather → Bot Settings → Domain` |
| Mini App URL (Menu button) | `https://constructpc.aleksandrantropov.ru` (v5.2.1 прод) | Бот устанавливает через `set_chat_menu_button` (см. `Legacy/Construct/bot/main.py`) |
| Allowed Telegram IDs | `661916730, 932026723` | `.env` → `TELEGRAM_ALLOWED_IDS` |

## Сценарий A: локальная разработка v6

Для локального теста Login Widget нужен HTTPS-tunnel:

```bash
# вариант 1 — cloudflared (рекомендую)
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
# даст URL вида https://random-name.trycloudflare.com

# вариант 2 — ngrok
brew install ngrok
ngrok http 3000
```

Полученный домен временно прописываем в `@BotFather → /setdomain → ConstructFinance_bot → <твой-tunnel-домен>`.

**Важно:** домен Login Widget в BotFather — **один**. Пока стоит туннель v6, v5.2.1 не сможет принимать новых логинов. Возвращай `aleksandrantropov.online` после теста.

## Сценарий B: staging для v6

Когда хочется протестить v6 серьёзно, не ломая прод v5.2.1:

1. Поднимаем v6 на отдельном поддомене **`v6.aleksandrantropov.ru`** (VPS `45.82.254.230`, тот же сервер).
2. Прописываем nginx + Let's Encrypt для нового поддомена.
3. В `@BotFather` домен уже `aleksandrantropov.ru` (с подстановочными поддоменами), ничего менять не надо.
4. Открываем `https://v6.aleksandrantropov.ru/login` — Login Widget работает.

Это рабочая схема: домен `aleksandrantropov.ru` уже разрешён в BotFather, **любой его поддомен автоматически работает** для Login Widget — `*.aleksandrantropov.ru`.

## Сценарий C: cutover на прод

Когда v6 готов и должен заменить v5.2.1:

1. На VPS: `constructpc.aleksandrantropov.ru` начинает указывать на v6-стек (NGINX upstream меняем).
2. Старый v5.2.1 остаётся на отдельном поддомене (например `legacy.aleksandrantropov.ru`) на случай отката.
3. Меню-кнопку бота **не трогаем** — она по-прежнему `https://constructpc.aleksandrantropov.ru`, и теперь это v6.
4. БД отдельная (Postgres v6 на 5433 в Docker, v5.2.1 на 5432 нативно на VPS). Миграция данных — отдельная задача в post-MVP.

## Команды бота

Из `bot/main.py` (v5.2.1):

```python
commands = [
    BotCommand("start", "Начать работу"),
    BotCommand("app", "Открыть Mini App"),
    BotCommand("sheetsetup", "Настроить Google Sheets"),  # ← не нужно в v6
    BotCommand("help", "Справка"),
]
```

В v6 уведомлений не делаем (по решению блица), бота можно сократить до `/start` + меню-кнопка с Mini App URL. Сделаем это в фазе 5 (PWA + Mini App).

## Проверка работоспособности бота

```bash
# через curl:
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"
# должно вернуть {"ok":true,"result":{"id":8294880190,"username":"ConstructFinance_bot",...}}

# проверить меню-кнопку:
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChatMenuButton?chat_id=661916730"

# Текущий конфиг (на 2026-05-23):
#   ✅ token валидный
#   ✅ username: ConstructFinance_bot
#   ✅ webhook не установлен (polling-режим)
```

## Откуда брать актуальный token

Token периодически ротируется. Источники в порядке свежести:

1. **VPS:** `/srv/construct/app/.env` (deploy ssh ключ `~/.ssh/deploy_ferrum`):
   ```bash
   ssh -i ~/.ssh/deploy_ferrum root@45.82.254.230 \
     'grep TELEGRAM_BOT_TOKEN /srv/construct/app/.env'
   ```
2. **GitHub Secrets:** `gh secret list -R Keylol/construct-fin` — имена видны, значения не читаются. Только setting:
   ```bash
   gh secret set TELEGRAM_BOT_TOKEN -R Keylol/construct-fin
   ```
3. **BotFather:** `/mybots → ConstructFinance_bot → API Token → Revoke current token`. После этого нужно обновить и `.env`, и GitHub Secret, и `/srv/construct/app/.env` на VPS.
