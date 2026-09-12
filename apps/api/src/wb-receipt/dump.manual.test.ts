import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractPdfLines } from './pdf-text';

const F = process.env.PDF ?? '';
describe.skipIf(!F)('дамп строк pdf', () => {
  it('печатает', async () => {
    const lines = await extractPdfLines(readFileSync(F));
    lines.forEach((l, i) => console.log(String(i).padStart(3), JSON.stringify(l).slice(0, 150)));
  }, 120_000);
});
