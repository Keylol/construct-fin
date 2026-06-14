import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// Конфиг для DB-backed интеграционных тестов. Один форк, без параллелизма —
// тесты делят одну тестовую БД и чистят её между собой через TRUNCATE.
//
// SWC-трансформ нужен для HTTP-e2e, поднимающих реальный AppModule: NestJS DI
// требует emitDecoratorMetadata (design:paramtypes), который esbuild (дефолт
// vitest) НЕ эмитит → инжектится undefined. SWC с decoratorMetadata это чинит.
// Сервис-уровневые тесты (new Service(...)) от трансформа не страдают.
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
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
