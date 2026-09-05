import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { matchCostsToItems } from '@construct/shared';
import { parseOrderSpecDocx } from './spec-parser';
import { detectAndParseReceipt } from '../wb-receipt/receipt-detect';

/**
 * Прогон всей цепочки мастера «Заказ из архива» по живым папкам клиентов:
 * спецификация → чеки закупки → подстановка себестоимости. Файлы в репозиторий
 * не кладём (ФИО, телефоны), поэтому включается каталогом:
 *
 *   ARCHIVE_DIR=/путь/к/архивам pnpm --filter @construct/api test costs-match.manual
 *
 * Внутри ARCHIVE_DIR — по подпапке на клиента, в каждой .docx спецификация и
 * PDF-чеки. Печатает по архиву, сколько позиций получили цену и почему, какие
 * строки чеков остались лишними и какие файлы не опознались.
 */
const DIR = process.env.ARCHIVE_DIR ?? '';
/** Доля позиций, получивших цену автоматически. Ниже — сопоставление сломалось. */
const MIN_MATCH_SHARE = Number(process.env.MATCH_MIN_SHARE ?? '0.7');

describe.skipIf(!DIR || !existsSync(DIR))('живые архивы: цены из чеков', () => {
  it('позиции спецификации получают себестоимость из чеков', async () => {
    const folders = readdirSync(DIR).filter((n) => statSync(join(DIR, n)).isDirectory());
    expect(folders.length).toBeGreaterThan(0);

    let items = 0;
    let matched = 0;
    const bySource = new Map<string, number>();
    const failures: string[] = [];

    for (const folder of folders.sort()) {
      const path = join(DIR, folder);
      const files = readdirSync(path);
      const specs = files.filter((n) => n.toLowerCase().endsWith('.docx'));
      if (specs.length === 0) {
        failures.push(`${folder}: нет .docx`);
        continue;
      }

      // В папке рядом с основной спецификацией лежат доборы («Часть 2», «Диск»)
      // на одну-две позиции — заказ описывает самая полная.
      const drafts = await Promise.all(
        specs.map(async (n) => parseOrderSpecDocx(readFileSync(join(path, n)))),
      );
      const draft = drafts.reduce((a, b) => (b.items.length > a.items.length ? b : a));
      const lines: { name: string; unitPrice: string; qty: string; file: string }[] = [];
      const unread: string[] = [];

      for (const pdf of files.filter((n) => n.toLowerCase().endsWith('.pdf'))) {
        try {
          const r = await detectAndParseReceipt(readFileSync(join(path, pdf)));
          bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
          if (r.items.length === 0) unread.push(`${pdf.slice(0, 26)} → ${r.source}`);
          r.items.forEach((i) =>
            lines.push({ name: i.name, unitPrice: i.unitPrice, qty: i.qty, file: pdf }),
          );
        } catch (e) {
          failures.push(`${folder}/${pdf}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const specItems = draft.items.map((i) => ({ name: `${i.kind}: ${i.name}` }));
      const pairs = matchCostsToItems(specItems, lines);
      items += specItems.length;
      matched += pairs.length;

      const cost = pairs.reduce(
        (acc, p) => acc + Number(p.unitCost) * Number(lines[p.lineIndex]?.qty ?? 1),
        0,
      );
      const multi = lines.filter((l) => Number(l.qty) > 1).length;
      const dupes = lines.length - new Set(lines.map((l) => l.name)).size;

      console.log(
        `\n${folder}\n  позиций ${specItems.length}, строк чеков ${lines.length}` +
          `, сопоставлено ${pairs.length}, себестоимость ${cost.toFixed(2)}` +
          `, итог спецификации ${draft.total ?? '—'}` +
          (multi > 0 ? `, строк с количеством > 1: ${multi}` : '') +
          (dupes > 0 ? `, дублей названий: ${dupes}` : ''),
      );
      specItems.forEach((it, i) => {
        const p = pairs.find((x) => x.itemIndex === i);
        console.log(
          p
            ? `    ✓ ${it.name.slice(0, 44).padEnd(44)} ${p.unitCost.padStart(10)}  ${p.reasons.join(', ')}`
            : `    · ${it.name.slice(0, 44).padEnd(44)} ${'—'.padStart(10)}  цены нет`,
        );
      });
      const used = new Set(pairs.map((p) => p.lineIndex));
      lines.forEach((l, i) => {
        if (!used.has(i)) console.log(`    ⌀ лишняя строка чека: ${l.name.slice(0, 50)} ${l.unitPrice}`);
      });
      unread.forEach((u) => console.log(`    ✗ не прочитан: ${u}`));
    }

    const share = items === 0 ? 0 : matched / items;
    console.log(
      `\nитого: позиций ${items}, сопоставлено ${matched} (${(share * 100).toFixed(1)} %)` +
        `\nисточники чеков: ${[...bySource].map(([s, n]) => `${s}:${n}`).join(', ')}`,
    );
    if (failures.length > 0) console.log('сбои:\n  ' + failures.join('\n  '));

    expect(failures, 'разбор не должен падать ни на одном живом файле').toEqual([]);
    expect(share, `сопоставлено ${(share * 100).toFixed(1)} %`).toBeGreaterThanOrEqual(
      MIN_MATCH_SHARE,
    );
  }, 600_000);
});
