import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { computeRowHash, type RowHashInput } from '../common/import-hash';

/** Столько одинаковых операций подряд не бывает — дальше это сбой, а не близнецы. */
const MAX_OCCURRENCE = 50;

/**
 * Отпечаток проводки, которую порождает строка выписки.
 *
 * Отпечаток уникален среди живых проводок и считается по содержимому строки, а
 * у банка бывают строки-близнецы: две одинаковые операции одного дня под разными
 * номерами документов — возврат, который банк провёл дважды, две одинаковые
 * комиссии. С одним отпечатком на двоих вторую нельзя было провести (409), а
 * синк с правилом терял её молча: конфликт принимался за «строка уже загружена».
 *
 * Поэтому первая получает обычный отпечаток, следующая — с номером повтора.
 * Номер растёт, только пока отпечаток занят проводкой ДРУГОЙ строки выписки.
 * Проводка без строки (загружена раньше файлом или осталась от прежнего
 * подключения) — это та же операция, а не близнец: её отпечаток возвращаем как
 * есть, и уникальность не даёт её задвоить.
 */
export async function bankLineHash(
  db: Prisma.TransactionClient,
  input: RowHashInput,
): Promise<string> {
  for (let occurrence = 1; occurrence <= MAX_OCCURRENCE; occurrence++) {
    const hash = computeRowHash({ ...input, occurrence });
    const holder = await db.transaction.findFirst({
      where: { workspaceId: input.workspaceId, importHash: hash, deletedAt: null },
      select: { bankLine: { select: { id: true } } },
    });
    if (!holder?.bankLine) return hash;
  }
  throw new ConflictException('Слишком много одинаковых строк выписки подряд');
}
