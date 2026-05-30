import { defineConfig } from 'vitest/config';

// Конфиг для DB-backed интеграционных тестов. Один форк, без параллелизма —
// тесты делят одну тестовую БД и чистят её между собой через TRUNCATE.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
