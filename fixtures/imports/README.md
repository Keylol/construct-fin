# Import fixtures

Drop sample bank statements here so parsers can be written against real data and tests can pin to fixtures.

Expected files:

- `alfa-sample.xlsx` — Альфа-Банк выписка в Excel
- `tinkoff-sample.pdf` — Т-Банк выписка в PDF (текстовый, не скан)
- `wb-sample.pdf` — Wildberries отчёт в PDF (текстовый)

Replace amounts/names with masked values if needed — only column structure matters.

Fixtures live outside `apps/api` so they're not bundled into builds.
