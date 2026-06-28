import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TransactionalContext } from '../common/transactional-context';

@Global()
@Module({
  // TransactionalContext — синглтон (один AsyncLocalStorage на процесс),
  // нужен и глобальному IdempotencyInterceptor, и per-module UnitOfWork.
  providers: [PrismaService, TransactionalContext],
  exports: [PrismaService, TransactionalContext],
})
export class PrismaModule {}
