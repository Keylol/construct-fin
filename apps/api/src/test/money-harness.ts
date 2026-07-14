/**
 * Харнесс для DB-backed интеграционных тестов денежных потоков.
 *
 * Инстанцирует реальные сервисы (Order/Purchase/Warehouse/...) поверх живого
 * PrismaClient, направленного на тестовую БД. Сервисы создаются вручную — это
 * быстрее, чем поднимать Nest-модуль, и не требует ConfigModule.
 *
 * БД: construct_v6_test на локальном Postgres :5433. Создаётся и мигрируется
 * заранее (см. package.json → pretest:integration).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UnitOfWork } from '../common/unit-of-work';
import { TransactionalContext } from '../common/transactional-context';
import { AuditService } from '../audit/audit.service';
import { WarehouseRepository } from '../warehouse/warehouse.repository';
import { WarehouseService } from '../warehouse/warehouse.service';
import { OrderRepository } from '../orders/order.repository';
import { OrderService } from '../orders/order.service';
import { PurchaseService } from '../purchase/purchase.service';
import { PnlService } from '../reports/pnl.service';
import { TransferService } from '../transfer/transfer.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { MarginService } from '../trade-reports/margin.service';
import { ReceivablesService } from '../trade-reports/receivables.service';
import { CashflowService } from '../reports/cashflow.service';
import { TransactionService } from '../transaction/transaction.service';
import { ImportService } from '../import/import.service';
import { AccountService } from '../account/account.service';
import { CategoryService } from '../category/category.service';
import { CounterpartyService } from '../counterparty/counterparty.service';
import { Role } from '@prisma/client';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://construct:construct_dev_change_me@127.0.0.1:5433/construct_v6_test?schema=public';

export type Harness = {
  prisma: PrismaClient;
  orders: OrderService;
  purchases: PurchaseService;
  warehouse: WarehouseService;
  orderRepo: OrderRepository;
  pnl: PnlService;
  transfer: TransferService;
  reconciliation: ReconciliationService;
  tradeMargin: MarginService;
  tradeReceivables: ReceivablesService;
  cashflow: CashflowService;
  transactions: TransactionService;
  importSvc: ImportService;
  accounts: AccountService;
  categories: CategoryService;
  counterparties: CounterpartyService;
  audit: AuditService;
};

export function buildHarness(): Harness {
  // PrismaService наследует конструктор PrismaClient — передаём URL тестовой БД явно.
  const prisma = new PrismaService({
    datasources: { db: { url: TEST_DATABASE_URL } },
  }) as unknown as PrismaService & PrismaClient;

  const uow = new UnitOfWork(prisma, new TransactionalContext());
  const audit = new AuditService(prisma);
  const whRepo = new WarehouseRepository(prisma);
  const warehouse = new WarehouseService(prisma, whRepo, uow, audit);
  const orderRepo = new OrderRepository(prisma);
  const orders = new OrderService(prisma, orderRepo, uow, warehouse, audit);
  const purchases = new PurchaseService(prisma, uow, warehouse, audit);
  const pnl = new PnlService(prisma);

  // Доп. сервисы для e2e — все инстанцируются от того же prisma/uow/audit.
  const transfer = new TransferService(prisma, uow);
  const reconciliation = new ReconciliationService(prisma);
  const tradeMargin = new MarginService(prisma);
  const tradeReceivables = new ReceivablesService(prisma);
  const cashflow = new CashflowService(prisma);
  const transactions = new TransactionService(prisma, audit);
  const importSvc = new ImportService(prisma, orders, audit);
  const accounts = new AccountService(prisma);
  const categories = new CategoryService(prisma);
  const counterparties = new CounterpartyService(prisma);

  return {
    prisma,
    orders,
    purchases,
    warehouse,
    orderRepo,
    pnl,
    transfer,
    reconciliation,
    tradeMargin,
    tradeReceivables,
    cashflow,
    transactions,
    importSvc,
    accounts,
    categories,
    counterparties,
    audit,
  };
}

/** Удаляет все данные тестовой БД в порядке, безопасном для FK. */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  // TRUNCATE ... CASCADE на всех таблицах данных. RESTART IDENTITY не нужен (cuid).
  // Перечисляем ВСЕ таблицы данных явно (не полагаясь на каскад от родителей):
  // StockMovement/Transfer/AccountBalanceCheck чистятся CASCADE через FK, но
  // IdempotencyKey — автономная таблица без FK, поэтому CASCADE её НЕ затрагивает.
  // Без явного TRUNCATE ключи протекали между тестами: захардкоженный
  // Idempotency-Key + меняющийся url (новые ws/order id) → ложный 409
  // «использовался с другим запросом» во втором и последующих прогонах.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "BankStatementLine","IntegrationConnection",
      "Attachment","AuditLog","LotConsumption","StockLot","PurchaseLine","Purchase",
      "OrderReturn","OrderItem","PaymentScheduleEntry","Order","Transaction","StockMovement","Transfer","AccountBalanceCheck",
      "WarehouseItem","Counterparty","Category","Account",
      "ImportBatch","IdempotencyKey",
      "WorkspaceMember","Workspace","User"
    RESTART IDENTITY CASCADE
  `);
}

export type Seed = {
  userId: string;
  workspaceId: string;
  accountId: string;
};

/**
 * Засеивает складскую позицию ВМЕСТЕ с FIFO-партией (OPENING-лот + OPENING-движение),
 * чтобы derived-кэши WarehouseItem.qty/avgCost совпадали с истиной в StockLot.
 * Прямой `prisma.warehouseItem.create({qty, avgCost})` после перехода на FIFO даёт
 * позицию БЕЗ партий → списание/stockValue видят 0. Используй этот хелпер вместо него.
 * qty=0 (или unitCost не задан) — позиция без партии (как неоприходованная).
 */
export async function seedStockItem(
  prisma: PrismaClient,
  params: {
    workspaceId: string;
    createdById: string;
    name?: string;
    unit?: string;
    sku?: string | null;
    qty: string;
    unitCost: string;
    isArchived?: boolean;
    reorderPoint?: string | null;
    receivedAt?: Date;
    defaultSupplierId?: string | null;
  },
): Promise<{ id: string }> {
  const item = await prisma.warehouseItem.create({
    data: {
      workspaceId: params.workspaceId,
      name: params.name ?? 'Деталь',
      unit: params.unit ?? 'шт',
      sku: params.sku ?? null,
      qty: params.qty,
      avgCost: params.unitCost,
      isArchived: params.isArchived ?? false,
      reorderPoint: params.reorderPoint ?? null,
      defaultSupplierId: params.defaultSupplierId ?? null,
    },
  });
  if (Number(params.qty) > 0) {
    await prisma.stockLot.create({
      data: {
        workspaceId: params.workspaceId,
        warehouseItemId: item.id,
        qtyInitial: params.qty,
        qtyRemaining: params.qty,
        unitCost: params.unitCost,
        sourceType: 'OPENING',
        receivedAt: params.receivedAt ?? new Date(),
        createdById: params.createdById,
      },
    });
    await prisma.stockMovement.create({
      data: {
        workspaceId: params.workspaceId,
        warehouseItemId: item.id,
        type: 'OPENING',
        qtyDelta: params.qty,
        qtyAfter: params.qty,
        unitCost: params.unitCost,
        refType: 'Opening',
        createdById: params.createdById,
      },
    });
  }
  return { id: item.id };
}

/** Базовый набор: пользователь, workspace, один счёт. */
export async function seedBase(prisma: PrismaClient, telegramId: bigint): Promise<Seed> {
  const user = await prisma.user.create({
    data: { telegramId, username: 'test', firstName: 'Test' },
  });
  const ws = await prisma.workspace.create({
    data: { name: 'Test WS', ownerId: user.id },
  });
  const account = await prisma.account.create({
    data: { workspaceId: ws.id, name: 'Каса', type: 'CASH' },
  });
  return { userId: user.id, workspaceId: ws.id, accountId: account.id };
}

/**
 * Засеивает строку членства WorkspaceMember (composite PK workspaceId+userId).
 * Нужно для HTTP-e2e: WorkspaceGuard требует строку членства, иначе 403.
 * seedBase членство НЕ создаёт (сервис-уровень идёт мимо гардов).
 */
export async function seedMember(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  role: Role = Role.OWNER,
): Promise<void> {
  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role },
  });
}

/** Создаёт складскую позицию с нулевым остатком. */
export async function seedWarehouseItem(
  prisma: PrismaClient,
  workspaceId: string,
  name = 'Деталь A',
): Promise<string> {
  const item = await prisma.warehouseItem.create({
    data: { workspaceId, name },
  });
  return item.id;
}
