// API DTO зеркало бэка. Когда добавится monorepo OpenAPI generation,
// эти типы переедут в @construct/shared.

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
export type AccountType = 'CASH' | 'BANK' | 'CARD' | 'OTHER';
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

export interface Counterparty {
  id: string;
  name: string;
  contact: string | null;
  note: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Transaction {
  id: string;
  date: string;          // ISO
  amount: string;        // "1234.56"
  type: TxType;
  accountId: string;
  categoryId: string | null;
  counterpartyId: string | null;
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

export interface UserProfile {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
}
