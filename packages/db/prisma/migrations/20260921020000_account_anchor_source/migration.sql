-- Источник якоря начального остатка счёта: BANK — входящее сальдо выписки либо
-- вывод из остатка банка (синк); CHECK — фактический остаток из сверки, принятый
-- владельцем как якорь. Нужен, чтобы синк не перезаписывал якорь, поставленный
-- человеком: до этого банк молча перебивал его первым же синком.
ALTER TABLE "Account" ADD COLUMN "openingAnchorSource" TEXT;

-- Существующие якоря: из сверки — те, чья отметка совпадает с концом дня (UTC+5)
-- какого-нибудь снимка сверки по этому счёту (ровно так их пишет anchorFromCheck:
-- endOfDay(check.date)); остальные — из банка. Ручные остатки (без отметки)
-- остаются без источника.
UPDATE "Account" a
SET "openingAnchorSource" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "AccountBalanceCheck" c
    WHERE c."accountId" = a.id
      AND a."openingAnchoredAt" = (
        (c."date" + interval '5 hours')::date::timestamp
        + interval '1 day' - interval '5 hours' - interval '1 millisecond'
      )
  ) THEN 'CHECK'
  ELSE 'BANK'
END
WHERE a."openingAnchoredAt" IS NOT NULL;
