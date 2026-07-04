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

// ──────────── Category rules ────────────

export interface CategoryRule {
  id: string;
  workspaceId: string;
  keyword: string;
  categoryId: string;
  priority: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  category?: { id: string; name: string; kind: CategoryKind };
}

// ──────────── Движок правил (Rule) ────────────
// Обобщение CategoryRule до «условие → действие». Зеркалит фиксированный словарь
// бэкенда (apps/api/src/rule/rule.dto.ts + engine.ts). Только подсказки.

export type RuleConditionType =
  | 'DESCRIPTION_CONTAINS'
  | 'COUNTERPARTY_EQUALS'
  | 'ACCOUNT_EQUALS'
  | 'TYPE_EQUALS'
  | 'AMOUNT_RANGE'
  | 'SOURCE_EQUALS';

export type RuleCondition =
  | { type: 'DESCRIPTION_CONTAINS'; value: string }
  | { type: 'COUNTERPARTY_EQUALS'; counterpartyId: string }
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
  matchedRuleIds: string[];
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
