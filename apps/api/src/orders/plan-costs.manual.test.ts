import { describe, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { planCostApplication } from '@construct/shared';
import { parseOrderSpecDocx } from './spec-parser';
import { detectAndParseReceipt } from '../wb-receipt/receipt-detect';

/** Печатает готовый план подстановки закупки по каждой папке архива. */
const DIR = process.env.ARCHIVE_DIR ?? '';

describe.skipIf(!DIR || !existsSync(DIR))('план закупки по архивам', () => {
  it('печатает цены для ввода', async () => {
    const folders = readdirSync(DIR).filter((n) => statSync(join(DIR, n)).isDirectory());
    const out: Record<string, unknown> = {};
    for (const folder of folders.sort()) {
      const path = join(DIR, folder);
      const files = readdirSync(path);
      const specs = files.filter((n) => n.toLowerCase().endsWith('.docx'));
      if (specs.length === 0) continue;
      const drafts = await Promise.all(
        specs.map(async (n) => parseOrderSpecDocx(readFileSync(join(path, n)))),
      );
      const draft = drafts.reduce((a, b) => (b.items.length > a.items.length ? b : a));
      const lines: { name: string; unitPrice: string; qty: string }[] = [];
      for (const pdf of files.filter((n) => n.toLowerCase().endsWith('.pdf'))) {
        try {
          const r = await detectAndParseReceipt(readFileSync(join(path, pdf)));
          r.items.forEach((i) => lines.push({ name: i.name, unitPrice: i.unitPrice, qty: i.qty }));
        } catch { /* пропускаем нечитаемый файл */ }
      }
      const items = draft.items.map((i) => ({ name: `${i.kind}: ${i.name}`, qty: '1', unitCost: '' }));
      const plan = planCostApplication(items, lines);
      out[folder] = {
        phone: draft.phone ?? null,
        total: draft.total ?? null,
        items: items.map((it, i) => {
          const p = plan.applications.find((x) => x.itemIndex === i);
          return { name: it.name, cost: p ? p.unitCost : null };
        }),
      };
    }
    console.log('===PLAN===' + JSON.stringify(out));
  }, 600_000);
});
