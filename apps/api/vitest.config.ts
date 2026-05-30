import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Интеграционные тесты требуют живой БД — выносятся в отдельный прогон
    // (pnpm test:integration), чтобы дефолтный unit-прогон и CI оставались
    // быстрыми и без зависимости от Postgres.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
