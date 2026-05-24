export function parseAmount(raw: string | null | undefined, decimalSep?: '.' | ','): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  s = s.replace(/[₽р₸$€£]/gi, '').replace(/\s| /g, '').trim();
  if (!s) return null;

  let sep = decimalSep;
  if (!sep) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) sep = ',';
    else sep = '.';
  }

  if (sep === ',') {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }

  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;

  const num = Number(s);
  if (!Number.isFinite(num)) return null;
  return num.toFixed(2);
}

export function parseDate(raw: string | Date | null | undefined): Date | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;

  const s = String(raw).trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (iso) {
    const [, y, m, d, hh = '00', mm = '00', ss = '00'] = iso;
    const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)));
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  const dmy = /^(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (dmy) {
    const ddS = dmy[1] ?? '0';
    const mmS = dmy[2] ?? '0';
    const yyS = dmy[3] ?? '0';
    const hh = dmy[4] ?? '00';
    const mm = dmy[5] ?? '00';
    const ss = dmy[6] ?? '00';
    const year = yyS.length === 2 ? 2000 + Number(yyS) : Number(yyS);
    const dt = new Date(Date.UTC(year, Number(mmS) - 1, Number(ddS), Number(hh), Number(mm), Number(ss)));
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

const TYPE_EXPENSE_RX = /расход|expense|списан|debit|outflow|оплата|списание|покупка/i;
const TYPE_INCOME_RX = /приход|income|поступл|credit|inflow|зачислен|пополн/i;

export function detectType(raw: string | null | undefined, amount: string | null): 'INCOME' | 'EXPENSE' | null {
  if (raw) {
    if (TYPE_EXPENSE_RX.test(raw)) return 'EXPENSE';
    if (TYPE_INCOME_RX.test(raw)) return 'INCOME';
  }
  if (amount) {
    return amount.startsWith('-') ? 'EXPENSE' : 'INCOME';
  }
  return null;
}
