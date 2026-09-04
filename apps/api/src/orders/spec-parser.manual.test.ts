import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parseOrderSpecDocx } from './spec-parser';

/**
 * Прогон по живым спецификациям. Сами файлы в репозиторий не кладём — в них ФИО
 * и телефоны клиентов, — поэтому тест включается только с SPEC_DIR:
 *
 *   SPEC_DIR=/путь/к/папке pnpm --filter @construct/api test spec-parser.manual
 *
 * Нужен, когда шаблон спецификации поменяют: пять файлов за март–июль уже дали
 * три разных написания телефона и три названия итоговой строки.
 */
const DIR = process.env.SPEC_DIR ?? '';

describe.skipIf(!DIR || !existsSync(DIR))('живые спецификации', () => {
  it('в каждой находятся телефон, клиент, позиции и итог', async () => {
    const files = readdirSync(DIR).filter((n) => n.endsWith('.docx'));
    expect(files.length).toBeGreaterThan(0);

    for (const f of files) {
      const d = await parseOrderSpecDocx(readFileSync(`${DIR}/${f}`));
      expect(d.phone, `${f}: телефон`).toMatch(/^\+7\d{10}$/);
      expect(d.clientName, `${f}: заказчик`).toBeTruthy();
      expect(d.items.length, `${f}: позиции`).toBeGreaterThanOrEqual(5);
      expect(Number(d.total), `${f}: итог`).toBeGreaterThan(0);
      expect(d.warnings, `${f}: предупреждения`).toEqual([]);
    }
  });
});
