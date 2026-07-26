import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AttachmentService } from './attachment.service';

// #19: дедуп в store() — per-workspace (hash + workspaceId), файл лежит под
// каталогом workspace. Значит и подсчёт «ещё используется» при remove() должен
// быть per-workspace, иначе можно удалить с диска файл, нужный другому workspace.
function makeService(opts: {
  found: { id: string; hash: string; storagePath: string } | null;
  countResult: number;
}) {
  const count = vi.fn(async () => opts.countResult);
  const prisma = {
    attachment: {
      findFirst: vi.fn(async () => opts.found),
      delete: vi.fn(async () => undefined),
      count,
    },
  };
  const config = {
    get: (key: string) => {
      if (key === 'UPLOAD_DIR') return '/tmp/uploads';
      if (key === 'MAX_UPLOAD_SIZE_MB') return 10;
      return undefined;
    },
  };
   
  const service = new AttachmentService(prisma as any, config as any);
  return { service, prisma, count };
}

describe('AttachmentService.remove — per-workspace dedup count (#19)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('counts remaining usages scoped to the same workspace', async () => {
    const { service, count } = makeService({
      found: { id: 'a1', hash: 'deadbeef', storagePath: '/tmp/uploads/ws1/de/deadbeef' },
      countResult: 1, // ещё используется В ЭТОМ workspace
    });
    await service.remove('ws1', 'a1');
    // hash + workspaceId, не только hash
    expect(count).toHaveBeenCalledWith({ where: { hash: 'deadbeef', workspaceId: 'ws1' } });
  });
});
