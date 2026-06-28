import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// Конфиг для нагрузочных прогонов (*.loadtest.ts). Поднимает реальный AppModule,
// слушает порт, гоняет конкурентных сетевых клиентов. SWC-трансформ нужен по той
// же причине, что и в integration-конфиге: NestJS DI требует decoratorMetadata.
//
// Один форк, без параллелизма файлов (делят одну тестовую БД). Большой timeout —
// прогон 5 клиентов × ~1000 операций занимает минуты.
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
    include: ['src/**/*.loadtest.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 120_000,
    testTimeout: 600_000,
  },
});
