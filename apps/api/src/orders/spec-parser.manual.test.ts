import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { parseOrderSpecDocx } from './spec-parser';

/**
 * Прогон по живым спецификациям. Сами файлы в репозиторий не кладём — в них ФИО
 * и телефоны клиентов, — поэтому тест включается только с SPEC_DIR:
 *
 *   SPEC_DIR=/путь/к/папке pnpm --filter @construct/api test spec-parser.manual
 *
 * Два режима. По умолчанию — перепись популяции: печатает сводку и требует лишь,
 * чтобы парсер никого не уронил и доля чистых разборов держалась выше порога.
 * Строгий (SPEC_STRICT=1) требует пустых предупреждений у каждого файла — он
 * канарейка «шаблон не менялся» для маленькой курируемой папки: на сотне живых
 * файлов первый же warning валит прогон вместе с отчётом, ради которого он и
 * затевался.
 */
const DIR = process.env.SPEC_DIR ?? '';
const STRICT = process.env.SPEC_STRICT === '1';
/** Доля файлов, разобранных без единого предупреждения. Ниже — шаблон поехал. */
const MIN_CLEAN_SHARE = Number(process.env.SPEC_MIN_CLEAN ?? '0.9');
/** Куда сложить реестр разобранного (телефон, дата, итог) — рядом с файлами, не в репозиторий. */
const OUT = process.env.SPEC_OUT ?? '';

describe.skipIf(!DIR || !existsSync(DIR))('живые спецификации', () => {
  it('в каждой находятся телефон, клиент, позиции и итог', async () => {
    const files = readdirSync(DIR).filter((n) => n.endsWith('.docx'));
    expect(files.length).toBeGreaterThan(0);

    const registry: Record<string, unknown>[] = [];
    const warnClasses = new Map<string, string[]>();
    const broken: string[] = [];
    const longNames: { file: string; len: number; name: string }[] = [];
    let clean = 0;
    let items = 0;

    for (const f of files) {
      if (STRICT) {
        const d = await parseOrderSpecDocx(readFileSync(`${DIR}/${f}`));
        expect(d.phone, `${f}: телефон`).toMatch(/^\+7\d{10}$/);
        expect(d.clientName, `${f}: заказчик`).toBeTruthy();
        expect(d.items.length, `${f}: позиции`).toBeGreaterThanOrEqual(5);
        expect(Number(d.total), `${f}: итог`).toBeGreaterThan(0);
        expect(d.warnings, `${f}: предупреждения`).toEqual([]);
        continue;
      }

      try {
        const d = await parseOrderSpecDocx(readFileSync(`${DIR}/${f}`));
        const bad: string[] = [...d.warnings];
        if (!/^\+7\d{10}$/.test(d.phone ?? '')) bad.push('телефон не в формате +7XXXXXXXXXX');
        if (!d.clientName) bad.push('нет заказчика');
        if (d.items.length < 5) bad.push(`позиций меньше пяти: ${d.items.length}`);
        if (!(Number(d.total) > 0)) bad.push('итог не разобран');

        items += d.items.length;
        registry.push({
          file: f,
          phone: d.phone,
          date: d.date,
          client: d.clientName,
          title: d.title,
          total: d.total,
          itemCount: d.items.length,
          warnings: bad,
        });
        // Позиция уезжает в заказ как «вид: наименование», а имя ограничено 200
        // символами в контракте API — длинные ловим здесь, а не отказом на «Создать».
        d.items.forEach((it) => {
          const name = `${it.kind}: ${it.name}`;
          if (name.length > 200) longNames.push({ file: f, len: name.length, name });
        });

        if (bad.length === 0) clean += 1;
        // Классы, а не тексты: «Не удалось разобрать дату» с разными файлами — один класс.
        bad.forEach((w) => {
          const key = w.replace(/«[^»]*»/g, '«…»').replace(/\d+/g, 'N');
          warnClasses.set(key, [...(warnClasses.get(key) ?? []), f]);
        });
      } catch (e) {
        broken.push(`${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (STRICT) return;

    const share = clean / files.length;
    console.log(`\nфайлов: ${files.length}, чистых: ${clean} (${(share * 100).toFixed(1)} %)`);
    console.log(`позиций всего: ${items}, в среднем ${(items / files.length).toFixed(1)} на файл`);
    if (warnClasses.size > 0) {
      console.log('\nклассы предупреждений:');
      [...warnClasses.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .forEach(([w, fs]) => console.log(`  ${String(fs.length).padStart(3)}  ${w}\n       напр.: ${fs[0]}`));
    }
    if (longNames.length > 0) {
      console.log(`\nимён длиннее 200 символов: ${longNames.length}`);
      longNames.slice(0, 5).forEach((l) => console.log(`  ${l.len}  ${l.file}`));
    }
    if (broken.length > 0) console.log('\nисключения:', broken.join('\n  '));
    if (OUT) {
      writeFileSync(OUT, JSON.stringify(registry, null, 1));
      console.log(`\nреестр: ${OUT}`);
    }

    expect(broken, 'парсер не должен падать ни на одном живом файле').toEqual([]);
    expect(share, `чистых разборов ${(share * 100).toFixed(1)} %`).toBeGreaterThanOrEqual(
      MIN_CLEAN_SHARE,
    );
  }, 300_000);
});
