import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Интеграционные И функциональные тесты требуют живой БД (и SWC для DI) —
    // выносятся в отдельные прогоны (test:integration / test:functional), чтобы
    // дефолтный unit-прогон и CI оставались быстрыми и без зависимости от Postgres.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.ts',
      '**/*.functional.test.ts',
    ],
  },
});
