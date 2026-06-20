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
}

export interface OrderListPage {
  items: Order[];
  nextCursor: string | null;
}

export type TransactionKind =
  | 'ORDER_PAYMENT'
  | 'CAPITAL_IN'
  | 'ORDER_REFUND'
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
