// API DTO зеркало бэка. Когда добавится monorepo OpenAPI generation,
// эти типы переедут в @construct/shared.

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
export type AccountType = 'CASH' | 'BANK' | 'OTHER';
export type CategoryKind = 'INCOME' | 'EXPENSE';
export type TxType = 'INCOME' | 'EXPENSE';

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  ownerId: string;
  createdAt?: string;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  openingBalance: string;
  note: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Transfer {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  /// Переводимая сумма (поступает на счёт-получатель).
  amount: string;
  /// Комиссия за перевод (реальный расход на счёте-источнике сверх amount).
  fee: string;
  date: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  parentId: string | null;
  isFixedCost: boolean;
  isArchived: boolean;
}

export interface CategoryTreeNode extends Category {
  children: CategoryTreeNode[];
}

export type CounterpartyRole = 'CLIENT' | 'SUPPLIER' | 'EMPLOYEE' | 'OTHER';

export interface Counterparty {
  id: string;
  name: string;
  role: CounterpartyRole;
  contact: string | null;
  note: string | null;
  inn: string | null;
  source: string | null;
  position: string | null;
  payRate: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseItem {
  id: string;
  sku: string | null;
  name: string;
  /** Цвет комплектующего — свободный текст, на учёт не влияет. */
  color: string | null;
  unit: string;
  qty: string;
  avgCost: string;
  defaultSupplierId: string | null;
  note: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseLine {
  id: string;
  warehouseItemId: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  warehouseItem?: { id: string; name: string; unit?: string };
}

export interface Purchase {
  id: string;
  supplierId: string | null;
  supplier?: { id: string; name: string } | null;
  note: string | null;
  createdAt: string;
  transaction?: { id: string; date: string; amount: string; accountId: string };
  lines: PurchaseLine[];
}

export type OrderStatus = 'OPEN' | 'DONE' | 'CANCELLED';
export type OrderPaymentState =
  | 'UNPAID'
  | 'PARTIAL'
  | 'PAID'
  | 'OVERPAID'
  | 'REFUNDED';

/** Источник себестоимости строки заказа (F1): факт / ручной ввод / оценка по складу. */
export type OrderCostSource = 'actual' | 'manual' | 'estimate' | null;

/** Маржа строки заказа — считает бэкенд (Decimal), фронт только рисует (D4). */
export interface OrderItemMargin {
  revenue: string;
  cogs: string;
  margin: string;
  marginPct: string;
  costSource: OrderCostSource;
}

/** Итог маржи заказа (база — totalAmount; возвраты по netQty). */
export interface OrderMarginSummary {
  revenue: string;
  cogs: string;
  margin: string;
  marginPct: string;
  isEstimate: boolean;
}

export interface OrderItem {
  id: string;
  warehouseItemId: string | null;
  name: string;
  qty: string;
  unitPrice: string;
  unitCost: string | null;
  unitCostAtSale: string | null;
  returnedQty: string;
  lineTotal: string;
  /** Optional: старые ответы в кэше React Query могут быть без маржи. */
  margin?: OrderItemMargin;
}

/** F5: источник партии на складе. */
export type StockLotSource =
  | 'PURCHASE'
  | 'OPENING'
  | 'MIGRATION'
  | 'ADJUSTMENT'
  | 'RETURN_CUSTOMER';

/** F5: ссылка на партию в трассировке (строка заказа → партии). */
export interface TraceLotRef {
  lotId: string;
  qty: string;
  unitCost: string;
  receivedAt: string;
  sourceType: StockLotSource;
  supplier: { id: string; name: string } | null;
  account: { id: string; name: string } | null;
}

export interface OrderItemTrace {
  orderItemId: string;
  lots: TraceLotRef[];
}

export interface OrderTrace {
  items: OrderItemTrace[];
}

/** F5: открытая партия позиции склада. */
export interface OpenLotView {
  id: string;
  receivedAt: string;
  qtyInitial: string;
  qtyRemaining: string;
  unitCost: string;
  sourceType: StockLotSource;
  supplier: { id: string; name: string } | null;
  account: { id: string; name: string } | null;
}

/** F2: статус строки графика платежей (покрытие FIFO из paidAmount). */
export type ScheduleEntryStatus = 'PAID' | 'PARTIAL' | 'PENDING' | 'OVERDUE';

export interface OrderScheduleEntry {
  id: string;
  seq: number;
  dueDate: string;
  amount: string;
  note: string | null;
  covered: string;
  remaining: string;
  status: ScheduleEntryStatus;
}

export interface OrderScheduleSummary {
  planned: string;
  /** false → Σ строк ≠ итогу заказа (UI предупреждает). */
  matchesTotal: boolean;
  overdueAmount: string;
  nextDueDate: string | null;
  nextDueAmount: string | null;
}

export interface OrderSchedule {
  entries: OrderScheduleEntry[];
  summary: OrderScheduleSummary;
}

export interface Order {
  id: string;
  number: string;
  clientId: string | null;
  client?: { id: string; name: string } | null;
  title: string | null;
  description: string | null;
  status: OrderStatus;
  paymentStatus: OrderPaymentState;
  subtotal: string;
  discountAmount: string;
  totalAmount: string;
  paidAmount: string;
  expectedDate: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items?: OrderItem[];
  transactions?: Transaction[];
  attachments?: AttachmentSummary[];
  _count?: { items: number };
  /** Есть в карточных ответах (get/мутации); в списке отсутствует. */
  margin?: OrderMarginSummary;
  /** F2: график платежей — в карточных ответах; null, если графика нет. */
  schedule?: OrderSchedule | null;
  /** F2: сводка графика в элементах СПИСКА (бейдж просрочки); null — нет графика. */
  scheduleSummary?: OrderScheduleSummary | null;
}

export interface OrderListPage {
  items: Order[];
  nextCursor: string | null;
}

export type TransactionKind =
  | 'ORDER_PAYMENT'
  | 'CAPITAL_IN'
  | 'SUPPLIER_REFUND'
  | 'ORDER_REFUND'
  | 'COGS'
  | 'WRITE_OFF'
  | 'PURCHASE'
  | 'SALARY'
  | 'TAX'
  | 'FIXED_COST'
  | 'VARIABLE_COST'
  | 'NON_OP'
  | 'CAPITAL_OUT'
  | 'OTHER';

export interface Transaction {
  id: string;
  date: string;          // ISO
  amount: string;        // "1234.56"
  type: TxType;
  kind: TransactionKind;
  accountId: string;
  categoryId: string | null;
  counterpartyId: string | null;
  orderId: string | null;
  /** C1: null у ручной строки; задан у ноги перевода/комиссии. */
  transferGroupId: string | null;
  /** C1: false → строка порождена доменом, правится только через свой раздел. */
  editable: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionWithAttachments extends Transaction {
  attachments: AttachmentSummary[];
}

export interface AttachmentSummary {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface TransactionListPage {
  items: Transaction[];
  nextCursor: string | null;
}

export interface TransactionSummary {
  income: string;
  expense: string;
  net: string;
}

export type ImportSource =
  | 'GENERIC_CSV'
  | 'GENERIC_XLSX'
  | 'ALFA_XLSX'
  | 'TINKOFF_PDF'
  | 'WB_PDF';

export interface ColumnMapping {
  date: string;
  amount: string;
  type?: string;
  description?: string;
  counterparty?: string;
  amountDecimalSeparator?: '.' | ',';
}

export interface PreviewRow {
  rawIndex: number;
  date: string;
  amount: string;
  type: TxType;
  description: string | null;
  counterpartyName: string | null;
  resolvedCounterpartyId: string | null;
  suggestedCategoryId: string | null;
  importHash: string;
  isDuplicate: boolean;
  /**
   * Ф6: расход уже учтён разбором чека WB (совпали счёт+сумма+дата) — строка
   * исключается из импорта, иначе расход задвоится. null — совпадения нет.
   */
  receiptMatch: { receiptId: string; transactionId: string } | null;
  errors: string[];
  raw: Record<string, string>;
}

export interface PreviewResult {
  source: ImportSource;
  headers: string[];
  suggestedMapping: Partial<ColumnMapping>;
  encoding: string;
  filename: string;
  fileHash: string;
  rows: PreviewRow[];
  stats: { total: number; valid: number; invalid: number; duplicates: number };
}

export interface ImportBatch {
  id: string;
  source: ImportSource;
  filename: string;
  rowsTotal: number;
  rowsImported: number;
  rowsSkipped: number;
  createdAt: string;
  deletedAt: string | null;
  user: { firstName: string | null; username: string | null };
}

// ──────────── Движок правил (Rule) ────────────
// Обобщение CategoryRule до «условие → действие». Зеркалит фиксированный словарь
// бэкенда (apps/api/src/rule/rule.dto.ts + engine.ts). Только подсказки.

export type RuleConditionType =
  | 'DESCRIPTION_CONTAINS'
  | 'COUNTERPARTY_EQUALS'
  | 'COUNTERPARTY_INN_IN'
  | 'ACCOUNT_EQUALS'
  | 'TYPE_EQUALS'
  | 'AMOUNT_RANGE'
  | 'SOURCE_EQUALS';

export type RuleCondition =
  | { type: 'DESCRIPTION_CONTAINS'; value: string }
  | { type: 'COUNTERPARTY_EQUALS'; counterpartyId: string }
  | { type: 'COUNTERPARTY_INN_IN'; values: string[] }
  | { type: 'ACCOUNT_EQUALS'; accountId: string }
  | { type: 'TYPE_EQUALS'; value: TxType }
  | { type: 'AMOUNT_RANGE'; min?: string | null; max?: string | null }
  | { type: 'SOURCE_EQUALS'; value: 'IMPORT' | 'MANUAL' };

export type RuleActionType = 'SET_CATEGORY' | 'SET_COUNTERPARTY' | 'SET_ACCOUNT';

export type RuleAction =
  | { type: 'SET_CATEGORY'; categoryId: string }
  | { type: 'SET_COUNTERPARTY'; counterpartyId: string }
  | { type: 'SET_ACCOUNT'; accountId: string };

export type RuleAppliesTo = 'IMPORT' | 'MANUAL' | 'BOTH';

export interface Rule {
  id: string;
  workspaceId: string;
  name: string;
  priority: number;
  isActive: boolean;
  appliesTo: RuleAppliesTo;
  conditions: RuleCondition[];
  actions: RuleAction[];
  createdAt: string;
  updatedAt: string;
}

/** Ответ POST /rules/suggest: что подставить + какие правила сработали. */
export interface RuleSuggestion {
  categoryId?: string;
  counterpartyId?: string;
  accountId?: string;
  categoryRuleId?: string;
  matchedRuleIds: string[];
}

/** Ответ POST /rules/preview: сколько строк выписки зацепит черновик правила. */
export interface RulePreview {
  matched: number;
  /** Из них ещё на разборе — столько проведёт «Применить правила». */
  matchedPending: number;
  scanned: number;
  total: number;
  truncated: boolean;
  samples: {
    id: string;
    date: string;
    amount: string;
    direction: TxType;
    counterpartyName: string | null;
    description: string | null;
    status: string;
  }[];
}

/** Ответ POST /inbox/apply-rules. */
export interface ApplyRulesResult {
  scanned: number;
  posted: number;
  skipped: number;
  remaining: number;
}

// ──────────── Reports ────────────

export type PeriodPreset =
  | 'this-month'
  | 'prev-month'
  | 'this-quarter'
  | 'prev-quarter'
  | 'this-year'
  | 'prev-year'
  | 'ytd'
  | 'last-30d'
  | 'last-90d'
  | 'last-12m';

export type CompareMode = 'none' | 'prev' | 'yoy' | 'custom';

export interface CategoryBreakdown {
  categoryId: string | null;
  categoryName: string | null;
  income: string;
  expense: string;
}

export type ReportBucket =
  | 'REVENUE'
  | 'COGS'
  | 'PURCHASES'
  | 'FIXED'
  | 'VARIABLE'
  | 'TAX'
  | 'CAPITAL'
  | 'OTHER';

export interface BucketBreakdown {
  bucket: ReportBucket;
  income: string;
  expense: string;
}

export interface PnlBucket {
  label: string;
  from: string;
  to: string;
  income: string;
  expense: string;
  cogs: string;
  grossProfit: string;
  net: string;
  byCategory: CategoryBreakdown[];
  byBucket: BucketBreakdown[];
}

export interface PnlSeries {
  period: { from: string; to: string };
  buckets: PnlBucket[];
  totals: PnlBucket;
}

export interface PnlReport {
  primary: PnlSeries;
  comparison: PnlSeries | null;
}

export interface CashflowPoint {
  label: string;
  from: string;
  to: string;
  inflow: string;
  outflow: string;
  net: string;
  balance: string;
}

export interface CashflowSeries {
  accountId: string | null;
  accountName: string | null;
  openingBalance: string;
  points: CashflowPoint[];
}

export interface CashflowReport {
  period: { from: string; to: string };
  series: CashflowSeries[];
}

/** Бюджет план/факт: месячные лимиты расходов / планы доходов по категориям. */
export interface BudgetRow {
  id: string;
  categoryId: string;
  categoryName: string;
  kind: CategoryKind;
  amount: string;
  note: string | null;
  fact: string;
  usagePct: number;
  over: boolean;
}

export interface BudgetReport {
  month: string;
  rows: BudgetRow[];
  totals: {
    expensePlan: string;
    expenseFact: string;
    incomePlan: string;
    incomeFact: string;
    overCount: number;
  };
}

/** Точка безубыточности за период (методология ОПиУ/IJ9). */
export interface BreakevenReport {
  period: { from: string; to: string };
  revenue: string;
  variableCosts: { cogs: string; variable: string; total: string };
  fixedCosts: string;
  contributionMargin: string;
  contributionMarginPct: number | null;
  breakevenRevenue: string | null;
  safetyMarginPct: number | null;
  achievedPct: number | null;
}

/** Управленческий баланс «на сейчас» (активы / обязательства / капитал). */
export interface BalanceReport {
  asOf: string;
  assets: {
    cash: { total: string; accounts: { id: string; name: string; balance: string }[] };
    receivables: string;
    inventory: string;
    total: string;
  };
  liabilities: {
    customerAdvances: string;
    taxDue: string;
    total: string;
  };
  equity: string;
}

export interface BreakdownRow {
  id: string | null;
  name: string;
  income: string;
  expense: string;
  total: string;
  share: number;
  count: number;
}

export interface BreakdownReport {
  period: { from: string; to: string };
  type: 'INCOME' | 'EXPENSE' | 'ALL';
  totalIncome: string;
  totalExpense: string;
  rows: BreakdownRow[];
}

// ── Торговые отчёты (маржа / дебиторка) ────────────────────────────────────

export interface MarginRow {
  /** by-product: ключ=null, name=имя позиции. by-client: ключ=id клиента. */
  key: string | null;
  name: string;
  revenue: string;
  cogs: string;
  margin: string;
  /** Маржа в процентах, строкой с 2 знаками ("42.50"). */
  marginPct: string;
  qty: string;
}

export interface MarginReport {
  method: 'by-product' | 'by-client';
  totals: { revenue: string; cogs: string; margin: string; marginPct: string };
  rows: MarginRow[];
}

export interface AgingBuckets {
  '0-30': string;
  '30-60': string;
  '60+': string;
}

export type AgingBucketKey = '0-30' | '30-60' | '60+';

export interface ReceivableOrder {
  orderId: string;
  number: string;
  createdAt: string;
  ageDays: number;
  bucket: AgingBucketKey;
  total: string;
  paid: string;
  due: string;
  /** F2: просрочено по графику платежей; null — графика нет. */
  overdueByPlan: string | null;
  /** F2: ближайший срок по графику (ISO); null — нет графика / всё погашено. */
  nextDueDate: string | null;
}

export interface ReceivableClientRow {
  clientId: string | null;
  clientName: string;
  due: string;
  /** F2: Σ просроченного по графикам заказов клиента. */
  overdueByPlan: string;
  buckets: AgingBuckets;
  orders: ReceivableOrder[];
}

export interface ReceivablesReport {
  asOf: string;
  totalDue: string;
  /** F2: Σ просроченного по графикам всех заказов выборки. */
  overdueByPlanTotal: string;
  buckets: AgingBuckets;
  clients: ReceivableClientRow[];
}

// ── Сверка счетов ──────────────────────────────────────────────────────────

export interface BalanceCheck {
  id: string;
  accountId: string;
  date: string;
  actualBalance: string;
  note: string | null;
  createdAt: string;
}

export interface ReconciliationOperation {
  id: string;
  date: string;
  type: 'INCOME' | 'EXPENSE';
  kind: string;
  amount: string;
  description: string | null;
}

export interface ReconciliationReport {
  accountId: string;
  accountName: string;
  asOf: string;
  openingBalance: string;
  computedBalance: string;
  lastCheck: {
    id: string;
    date: string;
    actualBalance: string;
    computedBalance: string;
    discrepancy: string;
  } | null;
  unreconciled: {
    since: string | null;
    count: number;
    net: string;
    operations: ReconciliationOperation[];
  };
}

export interface UserProfile {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
}

export interface AuditActor {
  id: string;
  name: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  diff: unknown;
  createdAt: string;
  actor: AuditActor | null;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

// ── Интеграции (Ф1 «Полный автомат») ──
export type IntegrationProvider = 'ALFA' | 'TBANK' | 'WB_CARD';
export type IntegrationStatus = 'ACTIVE' | 'ERROR' | 'DISABLED';

export interface IntegrationConnection {
  id: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  keyLast4: string;
  /** Номер расчётного счёта у провайдера (Альфа); null — не задан. */
  accountNumber: string | null;
  /** Отпечаток клиентского сертификата mTLS; null — сертификат не загружен. */
  tlsFingerprint: string | null;
  /** Когда истекает сертификат (ISO); null — неизвестно или не загружен. */
  tlsExpiresAt: string | null;
  account: { id: string; name: string };
  lastSyncAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
}

export interface SyncResult {
  fetched: number;
  created: number;
  autoPosted: number;
}

export type AusnMark = 'INCOME' | 'EXPENSE' | 'NOT_COUNTED';

export type BankLineStatus = 'NEW' | 'AUTO_POSTED' | 'RESOLVED' | 'DISMISSED';

export interface InboxLine {
  id: string;
  date: string;
  amount: string;
  direction: TxType;
  counterpartyName: string | null;
  counterpartyInn: string | null;
  description: string | null;
  ausnMark: AusnMark | null;
  status: BankLineStatus;
  suggestedCategoryId: string | null;
  /** Правило, проведшее строку автоматически (имя null, если правило удалили). */
  appliedRule: { id: string; name: string | null } | null;
  provider: IntegrationProvider;
  account: { id: string; name: string };
}

export interface InboxPage {
  items: InboxLine[];
  nextCursor: string | null;
}

// ── Разбор закупок (Ф6 «Полный автомат»): WB / ДНС / Онлайн Трейд / ручной ──
export type WbLineTarget = 'WAREHOUSE' | 'ORDER' | 'SKIPPED';
export type ReceiptSource = 'WB_CARD' | 'DNS' | 'ONLINE_TRADE' | 'MANUAL';

/** Нормализованная позиция из парсера (штуки WB свёрнуты в кол-во). */
export interface WbParsedItem {
  name: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  sellerInn: string | null;
  sellerName: string | null;
  sourceRef: string | null;
}

export interface WbReceiptPreview {
  receipt: {
    source: ReceiptSource;
    receiptDate: string | null;
    checkNumber: string | null;
    fd: string | null;
    docNumber: string | null;
    totalAmount: string | null;
    items: WbParsedItem[];
    warnings: string[];
  };
  /** Операции карты-кандидаты для привязки денег (сумма == итогу, дата ±3д). */
  candidates: { id: string; date: string; amount: string; description: string | null }[];
  alreadyImported: { receiptId: string; importedAt: string } | null;
}

/** Строка commit-запроса: разметка оператора поверх позиции. */
export type WbCommitLine = {
  name: string;
  qty: string;
  unitPrice: string;
  sellerName?: string | null;
  sellerInn?: string | null;
  wbOrderHash?: string | null;
} & (
  | { target: 'WAREHOUSE'; warehouseItemId?: string; newItem?: { name: string; unit?: string } }
  | { target: 'ORDER'; orderId: string; salePrice?: string }
  | { target: 'SKIPPED' }
);

export interface WbCommitInput {
  accountId: string;
  source: ReceiptSource;
  money: { mode: 'link'; transactionId: string } | { mode: 'create'; categoryId?: string | null };
  /** Ключ дедупа: номер документа (обязателен для не-MANUAL). */
  docNumber?: string | null;
  fd?: string | null;
  checkNumber?: string | null;
  receiptDate: string;
  totalAmount: string;
  note?: string | null;
  lines: WbCommitLine[];
}

export interface WbReceiptListItem {
  id: string;
  source: ReceiptSource;
  fpd: string | null;
  checkNumber: string | null;
  receiptDate: string;
  totalAmount: string;
  transactionCreated: boolean;
  createdAt: string;
  deletedAt: string | null;
  account: { id: string; name: string };
  transaction: { id: string; date: string; amount: string } | null;
  createdBy: { firstName: string | null; username: string | null };
  _count: { lines: number };
}

// ── Налог АУСН Д−Р (Ф4 «Полный автомат») ──
export interface TaxMonthRow {
  month: string; // «YYYY-MM»
  year: number;
  monthNo: number;
  income: string;
  expense: string;
  base: string;
  taxCalc: string;
  taxMin: string;
  taxDue: string;
  taxPaid: string;
  dueDate: string;
  status: 'UNPAID' | 'PARTIAL' | 'PAID' | 'NONE';
  incomeCount: number;
  expenseCount: number;
}

export interface TaxYearReport {
  year: number;
  rate: number;
  minRate: number;
  months: TaxMonthRow[];
  totals: { income: string; expense: string; taxDue: string; taxPaid: string };
}

export interface TaxPayInput {
  year: number;
  month: number;
  accountId: string;
  amount: string;
  date?: string;
  note?: string | null;
}

// ── Регулярные и плановые платежи (Ф5 «Полный автомат») ──
export type PlannedTxKind =
  | 'FIXED_COST'
  | 'VARIABLE_COST'
  | 'SALARY'
  | 'TAX'
  | 'NON_OP'
  | 'OTHER';
export type RecurrenceCadence = 'MONTHLY' | 'WEEKLY';
export type PlannedSource = 'RECURRING' | 'SALARY' | 'MANUAL';
export type PlannedStatus = 'PLANNED' | 'PAID' | 'SKIPPED' | 'CANCELLED';

export interface RecurringPayment {
  id: string;
  title: string;
  amount: string;
  txKind: PlannedTxKind;
  cadence: RecurrenceCadence;
  dayOfMonth: number | null;
  weekday: number | null;
  startDate: string;
  endDate: string | null;
  leadDays: number;
  isActive: boolean;
  accountId: string | null;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  note: string | null;
  nextDueDate: string | null;
}

export interface PlannedPayment {
  id: string;
  title: string;
  amount: string;
  txKind: PlannedTxKind;
  dueDate: string;
  source: PlannedSource;
  status: PlannedStatus;
  leadDays: number;
  dueInDays: number;
  overdue: boolean;
  soon: boolean;
  recurringId: string | null;
  recurringTitle: string | null;
  accountId: string | null;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  note: string | null;
  matchedTransactionId: string | null;
  autoTx: boolean;
}

export interface UpcomingPayments {
  horizonDays: number;
  items: PlannedPayment[];
  overdueCount: number;
  soonCount: number;
  overdueSum: string;
  soonSum: string;
}

/** Прогноз остатка на горизонте платёжного календаря (кассовый разрыв заранее). */
export interface ForecastPoint {
  date: string;
  out: string;
  in: string;
  balanceOut: string;
  balance: string;
}

export interface ForecastReport {
  horizonDays: number;
  asOf: string;
  opening: string;
  points: ForecastPoint[];
  totals: { out: string; in: string };
  overdueExpectedIn: string;
  firstGapOut: string | null;
  firstGapIn: string | null;
}

export interface CreateRecurringInput {
  title: string;
  amount: string;
  txKind?: PlannedTxKind;
  cadence: RecurrenceCadence;
  dayOfMonth?: number | null;
  weekday?: number | null;
  startDate: string;
  endDate?: string | null;
  leadDays?: number;
  isActive?: boolean;
  accountId?: string | null;
  categoryId?: string | null;
  counterpartyId?: string | null;
  note?: string | null;
}

export interface CreatePlannedInput {
  title: string;
  amount: string;
  txKind?: PlannedTxKind;
  dueDate: string;
  source?: 'SALARY' | 'MANUAL';
  leadDays?: number;
  accountId?: string | null;
  categoryId?: string | null;
  counterpartyId?: string | null;
  note?: string | null;
}

export interface PayPlannedInput {
  transactionId?: string;
  accountId?: string;
  amount?: string;
  date?: string;
  note?: string | null;
}
