/**
 * Seed-скрипт.
 *
 * По решению с блица: ничего не сеем при создании workspace —
 * пользователь создаёт все справочники сам. Скрипт оставлен как hook
 * для будущих пресетов (сборка ПК / сервис / фриланс).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // intentionally empty — пользователь создаёт всё с нуля
  // eslint-disable-next-line no-console
  console.log('Seed: nothing to do (clean-start policy).');
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
