import type { UrlCodec } from '@/hooks/useUrlFilters';

type Flat = Record<string, string | boolean>;

/**
 * Кодек для плоских фильтров справочника: строки и флаги. Значение, равное
 * умолчанию, в адрес не пишется — чистый URL остаётся чистым; флаг в адресе —
 * `1`. Для периодов и сложных фильтров (операции) кодек пишется руками.
 *
 *   const codec = flatCodec({ q: '', archived: false });
 *   const [filters, setFilters] = useUrlFilters(codec);
 */
export function flatCodec<T extends Flat>(defaults: T): UrlCodec<T> {
  const keys = Object.keys(defaults);
  return {
    keys,
    parse: (sp) => {
      const out: Flat = { ...defaults };
      for (const k of keys) {
        const raw = sp.get(k);
        if (raw === null) continue;
        out[k] = typeof defaults[k] === 'boolean' ? raw === '1' : raw;
      }
      return out as T;
    },
    serialize: (value) => {
      const sp = new URLSearchParams();
      for (const k of keys) {
        const v = value[k];
        if (v === defaults[k] || v === '' || v === undefined) continue;
        sp.set(k, typeof v === 'boolean' ? '1' : String(v));
      }
      return sp;
    },
  };
}
