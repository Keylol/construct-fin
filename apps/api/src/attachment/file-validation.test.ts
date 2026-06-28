import { describe, it, expect } from 'vitest';
import { assertAllowedAttachment } from './file-validation';

const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webp = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0x57, 0x45, 0x42, 0x50]),
]);
const heic = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from([0x66, 0x74, 0x79, 0x70]), // ftyp на offset 4
  Buffer.from([0x68, 0x65, 0x69, 0x63]), // 'heic' brand на offset 8
]);
// MP4: ftyp на offset 4, но бренд 'isom' (НЕ heic/heif) на offset 8.
const mp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from([0x66, 0x74, 0x79, 0x70]),
  Buffer.from([0x69, 0x73, 0x6f, 0x6d]), // 'isom'
]);
// RIFF-контейнер, но WAVE (не WEBP) на offset 8.
const wav = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0x57, 0x41, 0x56, 0x45]), // 'WAVE'
]);
const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // ELF executable

describe('assertAllowedAttachment', () => {
  it('пропускает валидный PDF', () => {
    expect(() => assertAllowedAttachment('application/pdf', pdf)).not.toThrow();
  });

  it('пропускает JPEG/PNG/WEBP/HEIC', () => {
    expect(() => assertAllowedAttachment('image/jpeg', jpeg)).not.toThrow();
    expect(() => assertAllowedAttachment('image/png', png)).not.toThrow();
    expect(() => assertAllowedAttachment('image/webp', webp)).not.toThrow();
    expect(() => assertAllowedAttachment('image/heic', heic)).not.toThrow();
  });

  it('нормализует mimeType с параметрами и регистром', () => {
    expect(() => assertAllowedAttachment('Application/PDF; charset=binary', pdf)).not.toThrow();
  });

  it('отклоняет тип не из whitelist', () => {
    expect(() => assertAllowedAttachment('application/x-sh', pdf)).toThrow(/Недопустимый тип/);
    expect(() => assertAllowedAttachment('', pdf)).toThrow(/Недопустимый тип/);
  });

  it('отклоняет подмену: исполняемый файл под видом PDF', () => {
    expect(() => assertAllowedAttachment('application/pdf', elf)).toThrow(/не соответствует/);
  });

  it('отклоняет PNG-mimeType с содержимым JPEG', () => {
    expect(() => assertAllowedAttachment('image/png', jpeg)).toThrow(/не соответствует/);
  });

  // #17: один лишь 'ftyp' проходит и для MP4/MOV — проверяем бренд на offset 8.
  it('отклоняет MP4 (ftyp без HEIF-бренда) под видом HEIC', () => {
    expect(() => assertAllowedAttachment('image/heic', mp4)).toThrow(/не соответствует/);
    expect(() => assertAllowedAttachment('image/heif', mp4)).toThrow(/не соответствует/);
  });

  // #18: RIFF сам по себе — ещё и WAV/AVI; требуем 'WEBP' на offset 8.
  it('отклоняет WAV (RIFF без WEBP) под видом WEBP', () => {
    expect(() => assertAllowedAttachment('image/webp', wav)).toThrow(/не соответствует/);
  });
});
