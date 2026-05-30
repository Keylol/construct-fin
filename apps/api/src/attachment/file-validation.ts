import { BadRequestException } from '@nestjs/common';

/**
 * Валидация загружаемых вложений. Назначение — фото позиций, договоры, чеки:
 * изображения и PDF. Любой другой тип отклоняется.
 *
 * Проверяем не только заявленный клиентом mimeType (его легко подделать), но и
 * «магические байты» содержимого — чтобы нельзя было залить исполняемый файл
 * под видом PDF/картинки.
 */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

type Sig = { offset: number; bytes: number[] };

// Сигнатуры по фактическому содержимому. Значение — список допустимых
// вариантов; достаточно совпадения хотя бы одного.
const SIGNATURES: Record<string, Sig[]> = {
  'application/pdf': [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }], // %PDF
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  'image/webp': [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }], // RIFF (+ WEBP на offset 8)
  // HEIC/HEIF: ISO-BMFF box 'ftyp' на offset 4.
  'image/heic': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
  'image/heif': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
};

function matches(buffer: Buffer, sig: Sig): boolean {
  if (buffer.length < sig.offset + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => buffer[sig.offset + i] === b);
}

/**
 * Бросает BadRequestException, если файл не из разрешённого списка или его
 * содержимое не соответствует заявленному типу.
 */
export function assertAllowedAttachment(mimeType: string, buffer: Buffer): void {
  const mime = mimeType?.toLowerCase().split(';')[0]?.trim();
  if (!mime || !ALLOWED_MIME.has(mime)) {
    throw new BadRequestException(
      `Недопустимый тип файла: ${mimeType || 'не указан'}. Разрешены PDF и изображения (JPEG, PNG, WEBP, HEIC).`,
    );
  }
  const sigs = SIGNATURES[mime];
  if (sigs && !sigs.some((s) => matches(buffer, s))) {
    throw new BadRequestException(
      'Содержимое файла не соответствует заявленному типу (возможна подмена расширения).',
    );
  }
}
