import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// Конфиг для функциональных тестов мутаций (Фаза 2.2): «кнопка → HTTP → БД»
// через реальный Nest+Fastify (buildHttpApp). Один форк, без параллелизма —
// делят одну тестовую БД, чистят через TRUNCATE (resetDb) в beforeEach.
//
// SWC-трансформ обязателен: buildHttpApp поднимает AppModule, NestJS DI требует
// emitDecoratorMetadata (design:paramtypes), который esbuild не эмитит.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2021',
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.functional.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
