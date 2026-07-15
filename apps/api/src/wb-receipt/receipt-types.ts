// Нормализованная форма разбора закупочного документа (WB / ДНС / Онлайн Трейд).
// Каждый парсер приводит свой формат к этой форме; сервис и UI работают только с
// ней. WB-специфика (ФПД, продавцы-«поверенные») ложится в общие поля docNumber/
// sellerName; ненужные источнику поля остаются null.

// MANUAL — источник не распознан: оператор вводит позиции сам (дедупа нет).
export type ParsedReceiptSource = 'WB_CARD' | 'DNS' | 'ONLINE_TRADE' | 'MANUAL';

export type ParsedReceiptItem = {
  name: string;
  /** Кол-во, Decimal-строка. */
  qty: string;
  unitPrice: string;
  lineTotal: string;
  /** Реальный продавец строки (WB — посредник; ДНС/ОТ — сам магазин). */
  sellerName: string | null;
  sellerInn: string | null;
  /** Ссылка на источник строки: хэш WB-заказа / код товара ДНС / код ОТ. */
  sourceRef: string | null;
};

export type ParsedReceipt = {
  source: ParsedReceiptSource;
  receiptDate: Date | null;
  /** Ключ дедупа = номер документа: ФПД (WB) / номер заказа-чека (ДНС/ОТ). */
  docNumber: string | null;
  /** Человекочитаемый номер чека/заказа для UI. */
  checkNumber: string | null;
  /** Номер фискального документа (WB/ДНС), форензика. */
  fd: string | null;
  totalAmount: string | null;
  items: ParsedReceiptItem[];
  /**
   * Несоответствия разбора. КОНТРАКТ: непустые warnings показываются оператору;
   * commit БЕЗ ручной правки блокируется (нельзя молча внести неполный документ).
   * Парсер чистый, не бросает.
   */
  warnings: string[];
};
