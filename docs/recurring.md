# Повторяющиеся транзакции

Construct v6 умеет автоматически создавать транзакции по расписанию: зарплата 5-го числа, аренда 1-го числа, подписки и т.д.

## Модель

`RecurringRule`:
- `name` — название («Зарплата», «Аренда»)
- `templateJson` — шаблон создаваемой транзакции: `{amount, type, accountId, categoryId?, counterpartyId?, description?}`
- `frequency` — `DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY`
- `interval` — каждые N единиц (every 2 weeks = WEEKLY + interval=2)
- `startDate` — с какой даты правило действует
- `endDate?` — опциональная дата завершения
- `dayOfMonth?` — для MONTHLY/YEARLY (1–31). При попытке выставить 31-е в феврале clamping до последнего дня месяца.
- `dayOfWeek?` — для WEEKLY (0=пн, 6=вс)
- `nextRunAt` — пересчитывается при создании/правке правила и после каждого запуска
- `lastRunAt` — отметка последнего запуска (null если правило ещё не отрабатывало)
- `active` — пауза без удаления

`Transaction.recurringRuleId` + `Transaction.recurringOccurrenceDate` + `@@unique([recurringRuleId, recurringOccurrenceDate])` — гарантия идемпотентности на уровне БД.

## Архитектура

```
[ApiController]
   POST   /workspaces/:wsId/recurring          — create rule
   GET    /workspaces/:wsId/recurring          — list
   GET    /workspaces/:wsId/recurring/:id
   PATCH  /workspaces/:wsId/recurring/:id
   DELETE /workspaces/:wsId/recurring/:id      — soft delete
   POST   /workspaces/:wsId/recurring/:id/run-now  — отладочный ручной запуск

[Scheduler — @nestjs/schedule]
   @Cron(EVERY_HOUR) tick()
     ↓ pg_try_advisory_lock (защита от scale-out гонок)
     ↓ runDue(now)
     ↓ pg_advisory_unlock

[Service]
   runDue(now):
     SELECT RecurringRule WHERE active AND nextRunAt <= now AND (endDate IS NULL OR endDate >= now)
     FOR EACH rule:
       runOne(rule, ownerId, now)

   runOne(rule, userId, now):
     occurrences = enumerateOccurrences(rule, lastRunAt, now)   // catch-up max 30 дней
     FOR EACH occurrenceDate:
       try { Transaction.create({ ..., recurringRuleId, recurringOccurrenceDate }) }
       catch (P2002) { skipped++ }      // unique-индекс защищает от дубля
     UPDATE rule SET lastRunAt = now, nextRunAt = computeNextRunAt(rule, now)
```

## Движок дат (`recurring.engine.ts`)

Чистые функции, без зависимости от Prisma:

- `nextOccurrence(rule, from)` — следующая дата от `from` по правилу. Для MONTHLY обрезает до последнего дня короткого месяца.
- `firstOccurrenceAfter(rule, floor)` — первая occurrence ≥ floor, шагая от startDate.
- `enumerateOccurrences(rule, {lastRunAt, now})` — все occurrences в окне `[max(startDate, lastRunAt+ε, now − 30д), now]`.
- `computeNextRunAt(rule, now)` — первая occurrence > now (или null если endDate прошло).

## Catch-up политика

При запуске scheduler смотрит на `lastRunAt`. Все occurrences между `lastRunAt` и `now` создаются с историческими датами — это нужно для арендных платежей и зарплат, где важно правильно отражать в прошлом периоде.

Лимит **30 дней** (`CATCH_UP_LIMIT_DAYS`) — защита от спама при долгом downtime или внезапной активации правила с давним `startDate`. Если scheduler был выключен 3 месяца, при следующем тике создаст только последние 30 дней.

## Идемпотентность

Двухуровневая:
1. **Логическая** в `enumerateOccurrences` — после `lastRunAt` правило не возвращает уже обработанные даты.
2. **БД** через `@@unique([recurringRuleId, recurringOccurrenceDate])` — даже при гонке двух воркеров вторая попытка `INSERT` поймает `P2002` и тихо пропустится.

Тест в `e2e-phase3.mjs`: повторный run-now создаёт 0 новых транзакций.

## Scale-out защита

Если API запущен в нескольких инстансах, чтобы они не задудлили транзакции, scheduler использует Postgres advisory-lock:

```sql
SELECT pg_try_advisory_lock(0x636f6e73);   -- 'cons' as bigint
```

Только тот инстанс, кто получил lock, запускает `runDue()`. Lock освобождается в `finally`. Если процесс умер до unlock — Postgres снимет автоматически в конце сессии.

## Отключение для тестов / staging

`RECURRING_SCHEDULER_DISABLED=1` в env — scheduler не тикает. `run-now` endpoint продолжает работать (для отладки).

## Что НЕ делает recurring

- Не отправляет нотификации о создании (только in-app через инвалидацию кеша)
- Не редактирует уже созданные транзакции при правке правила — старые остаются как есть, новые идут по новым параметрам
- Не поддерживает RRULE / cron-выражения (только структурированные поля DAILY/WEEKLY/MONTHLY/YEARLY)
- Не учитывает праздничные дни / переносы выходных

## Расписание cron

`@Cron(CronExpression.EVERY_HOUR)` — раз в час в xx:00. Можно изменить в `recurring.scheduler.ts`.

Для нагрузочных сценариев (тысячи правил) — расщепить на пачки или вынести в BullMQ воркер (фаза 5+).
