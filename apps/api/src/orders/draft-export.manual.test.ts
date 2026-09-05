import { describe, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { allocateSalePrices, matchCostsToItems, planCostApplication } from '@construct/shared';
import { parseOrderSpecDocx } from './spec-parser';
import { detectAndParseReceipt } from '../wb-receipt/receipt-detect';

/**
 * Черновики заказов из папок архива — тем же кодом, что работает в мастере.
 *
 *   ARCHIVE_DIR=<корень> DRAFT_OUT=<файл.json> [POOL=1] \
 *     pnpm --filter @construct/api test draft-export.manual
 *
 * Позиции берутся из спецификации, закупка — из чеков (planCostApplication),
 * цена продажи — распределением от итога (allocateSalePrices). Ничего никуда
 * не отправляет: заведение остаётся отдельным, видимым шагом.
 *
 * POOL=1 включает второй проход: позиции, которым цена не нашлась в своей
 * папке, ищутся в чеках соседних архивов. Так устроена закупка — один сводный
 * чек магазина лежит у одного клиента, а комплектующие в нём на несколько
 * сборок, и у соседей позиции остаются без цены. Защиты две: окно ±POOL_DAYS
 * дней от даты чека и однократное использование строки.
 */
const DIR = process.env.ARCHIVE_DIR ?? '';
const OUT = process.env.DRAFT_OUT ?? '';
const POOL = process.env.POOL === '1';
const POOL_DAYS = Number(process.env.POOL_DAYS ?? '30');

interface Line {
  name: string;
  unitPrice: string;
  qty: string;
}
interface PoolLine extends Line {
  from: string;
  date: number;
  used: boolean;
}
interface Draft {
  root: string;
  folder: string;
  phone: string | null;
  client: string | null;
  title: string | null;
  date: string | null;
  total: string | null;
  items: { name: string; qty: string; unitPrice: string; unitCost?: string; costFrom?: string }[];
  unread: string[];
  warnings: string[];
}

describe.skipIf(!DIR || !existsSync(DIR))('черновики заказов из архивов', () => {
  it('спецификация + чеки → позиции с закупкой и ценой продажи', async () => {
    const pool: PoolLine[] = [];
    const collected: {
      root: string;
      folder: string;
      draft: Awaited<ReturnType<typeof parseOrderSpecDocx>>;
      lines: Line[];
      unread: string[];
    }[] = [];

    // ── Проход 1: читаем документы, наполняем общий пул строк чеков ──────────
    for (const root of readdirSync(DIR)
      .filter((n) => statSync(join(DIR, n)).isDirectory())
      .sort()) {
      for (const folder of readdirSync(join(DIR, root))
        .filter((n) => statSync(join(DIR, root, n)).isDirectory())
        .sort()) {
        const path = join(DIR, root, folder);
        const files = readdirSync(path);
        const specs = files.filter((n) => n.toLowerCase().endsWith('.docx'));
        if (specs.length === 0) continue;

        // Рядом с основной спецификацией лежат доборы на одну-две позиции.
        const drafts = await Promise.all(
          specs.map(async (n) => parseOrderSpecDocx(readFileSync(join(path, n)))),
        );
        const draft = drafts.reduce((a, b) => (b.items.length > a.items.length ? b : a));

        const lines: Line[] = [];
        const unread: string[] = [];
        for (const pdf of files.filter((n) => n.toLowerCase().endsWith('.pdf'))) {
          try {
            const r = await detectAndParseReceipt(readFileSync(join(path, pdf)));
            if (r.items.length === 0) unread.push(`${pdf.slice(0, 30)} → ${r.source}`);
            r.items.forEach((i) => {
              const line = { name: i.name, unitPrice: i.unitPrice, qty: i.qty };
              lines.push(line);
              pool.push({
                ...line,
                from: folder,
                date: (r.receiptDate ?? new Date(draft.date ?? 0)).getTime(),
                used: false,
              });
            });
          } catch (e) {
            unread.push(`${pdf.slice(0, 30)} → ошибка: ${e instanceof Error ? e.message : ''}`);
          }
        }
        collected.push({ root, folder, draft, lines, unread });
      }
    }

    // ── Проход 2: свои чеки, затем добор из пула ─────────────────────────────
    const out: Draft[] = [];
    let fromPool = 0;

    for (const c of collected) {
      const base = c.draft.items.map((i) => ({
        name: `${i.kind}: ${i.name}`,
        qty: '1',
        unitCost: '',
      }));
      const plan = planCostApplication(base, c.lines);
      const items = base.map((it, idx) => {
        const a = plan.applications.find((x) => x.itemIndex === idx);
        return a?.applied
          ? { ...it, unitCost: a.unitCost, qty: a.qty, costFrom: 'своя папка' }
          : { ...it, costFrom: undefined as string | undefined };
      });

      // Строки своей папки, ушедшие в позиции, в пуле больше не свободны.
      items.forEach((it) => {
        if (!it.unitCost) return;
        const p = pool.find((x) => !x.used && x.from === c.folder && x.unitPrice === it.unitCost);
        if (p) p.used = true;
      });

      if (POOL) {
        const specAt = new Date(c.draft.date ?? 0).getTime();
        const free = pool
          .map((line, i) => ({ line, i }))
          .filter(
            ({ line }) =>
              !line.used &&
              line.from !== c.folder &&
              (!specAt || !line.date || Math.abs(line.date - specAt) < POOL_DAYS * 864e5),
          );
        const missing = items
          .map((it, i) => ({ it, i }))
          .filter(({ it }) => !it.unitCost);
        if (missing.length > 0 && free.length > 0) {
          const pairs = matchCostsToItems(
            missing.map(({ it }) => ({ name: it.name })),
            free.map(({ line }) => ({ name: line.name, unitPrice: line.unitPrice })),
          );
          pairs.forEach((p) => {
            const target = missing[p.itemIndex];
            const src = free[p.lineIndex];
            if (!target || !src) return;
            // Из чужой папки берём цену только при совпадении модели: похожие
            // слова там сплошь и рядом («Видеокарта», «Память»), а ошибка стоит
            // искажённой себестоимости, которую потом никто не поймает.
            if (!p.reasons.some((r) => r.startsWith('совпала модель'))) return;
            const item = items[target.i];
            if (!item || item.unitCost) return;
            item.unitCost = p.unitCost;
            item.qty = src.line.qty && Number(src.line.qty) > 1 ? src.line.qty : item.qty;
            item.costFrom = `чек архива «${src.line.from.slice(0, 24)}»`;
            src.line.used = true;
            fromPool += 1;
          });
        }
      }

      const prices = c.draft.total
        ? allocateSalePrices(
            items.map((i) => ({ qty: i.qty, unitCost: i.unitCost ?? '' })),
            c.draft.total,
          )
        : items.map(() => '0');

      const finalItems = items.map((it, i) => ({
        name: it.name.slice(0, 200),
        qty: it.qty,
        unitPrice: prices[i] ?? '0',
        unitCost: it.unitCost || undefined,
        costFrom: it.costFrom,
      }));

      const cost = finalItems.reduce((s, i) => s + Number(i.unitCost ?? 0) * Number(i.qty), 0);
      const total = Number(c.draft.total ?? 0);
      const marginPct = total > 0 ? ((total - cost) / total) * 100 : 0;

      out.push({
        root: c.root,
        folder: c.folder,
        phone: c.draft.phone,
        client: c.draft.clientName,
        title: c.draft.title,
        date: c.draft.date,
        total: c.draft.total,
        items: finalItems,
        unread: c.unread,
        warnings: c.draft.warnings,
      });

      console.log(
        `${c.folder.slice(0, 28).padEnd(28)} ${String(c.draft.total).padStart(10)} ₽  ` +
          `цен ${finalItems.filter((i) => i.unitCost).length}/${finalItems.length}, ` +
          `себестоимость ${cost.toFixed(0).padStart(8)}, маржа ${marginPct.toFixed(1)}%` +
          (c.unread.length ? `, не прочитано: ${c.unread.length}` : ''),
      );
    }

    if (POOL) console.log(`\nцен добрано из чужих чеков: ${fromPool}`);
    if (OUT) {
      writeFileSync(OUT, JSON.stringify(out, null, 1));
      console.log(`черновиков: ${out.length} → ${OUT}`);
    }
  }, 900_000);
});
