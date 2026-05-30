# Интеграционные тесты (DB-backed)

Тесты `*.integration.test.ts` гоняются против **реальной** Postgres-БД и
покрывают денежные потоки: закупка→склад→WAVG, finalize→списание+COGS,
cancel→сторно, синхронизация оплаты, атомарность (откат при продаже в минус).

Они **исключены** из дефолтного `pnpm test` (тот остаётся pure-unit и не требует
БД), чтобы не замедлять обычный прогон и CI.

## Как запустить локально

Нужен поднятый Postgres (`docker compose up postgres`, порт 5433) и отдельная
тестовая БД — её данные затираются между тестами (`TRUNCATE`), поэтому держим её
отдельно от dev.

```bash
# 1. Создать тестовую БД (один раз)
docker exec construct-v6-postgres psql -U construct -d construct_v6 \
  -c "CREATE DATABASE construct_v6_test"

# 2. Накатить схему
DATABASE_URL="postgresql://construct:construct_dev_change_me@127.0.0.1:5433/construct_v6_test?schema=public" \
  pnpm --filter @construct/db exec prisma migrate deploy

# 3. Прогнать тесты
TEST_DATABASE_URL="postgresql://construct:construct_dev_change_me@127.0.0.1:5433/construct_v6_test?schema=public" \
  pnpm --filter @construct/api run test:integration
```

`TEST_DATABASE_URL` (или `DATABASE_URL`) подхватывается харнессом
`src/test/money-harness.ts`. Если ни одна не задана — берётся локальный дефолт
на `construct_v6_test`.
