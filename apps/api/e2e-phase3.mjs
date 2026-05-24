#!/usr/bin/env node
// E2E проверка фазы 3 против живого API + Postgres
// Запуск: node /tmp/e2e-phase3.mjs

import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(payload, secret, expiresInSec = 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSec };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(fullPayload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

const BASE = 'http://localhost:4000';
const JWT_SECRET = 'c2f652d9fd31538526df56f921dc0ea380046886f2b346aded8676c880c5cd1eeada58ba568c5dd2fc9bd926f1e34959';
const ROOT = '/Users/alexander/Documents/construct-v6';

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label} ${extra}`);
    failed++;
  }
}

async function main() {
  console.log('--- Phase 3 e2e ---');

  // 1. Setup
  console.log('\n[setup]');
  const tgId = BigInt(Date.now()); // unique per run
  const user = await prisma.user.create({
    data: { telegramId: tgId, firstName: 'E2E', username: 'e2e_test' },
  });
  const workspace = await prisma.workspace.create({
    data: { name: 'E2E Phase 3', ownerId: user.id },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' },
  });
  const account = await prisma.account.create({
    data: { workspaceId: workspace.id, name: 'Test Cash', type: 'CASH' },
  });
  console.log(`  user=${user.id} ws=${workspace.id} account=${account.id}`);

  const token = signJwt({ sub: user.id, tg: tgId.toString() }, JWT_SECRET, 3600);
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const wsBase = `${BASE}/workspaces/${workspace.id}`;

  // 2. Recurring CRUD + run-now + idempotency
  console.log('\n[recurring]');
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  const createRes = await fetch(`${wsBase}/recurring`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Daily test',
      template: { amount: '100.00', type: 'EXPENSE', accountId: account.id },
      frequency: 'DAILY',
      interval: 1,
      startDate: fiveDaysAgo,
      active: true,
    }),
  });
  const rule = await createRes.json();
  check('POST /recurring', createRes.status === 201, `status=${createRes.status}`);
  check('rule has id', !!rule.id);

  const listRes = await fetch(`${wsBase}/recurring`, { headers });
  const list = await listRes.json();
  check('GET /recurring returns array', Array.isArray(list) && list.length === 1);

  const runRes = await fetch(`${wsBase}/recurring/${rule.id}/run-now`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const runResult = await runRes.json();
  check(
    `run-now creates 6 occurrences (5d catch-up + today, got ${runResult.created})`,
    runResult.created === 6,
  );

  const runAgain = await fetch(`${wsBase}/recurring/${rule.id}/run-now`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const runAgainResult = await runAgain.json();
  check(
    `idempotent: re-run creates 0 new (got ${runAgainResult.created})`,
    runAgainResult.created === 0,
  );

  const txCount = await prisma.transaction.count({
    where: { recurringRuleId: rule.id, deletedAt: null },
  });
  check(`exactly 6 tx in DB for rule (got ${txCount})`, txCount === 6);

  const patchRes = await fetch(`${wsBase}/recurring/${rule.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name: 'Daily test renamed', active: false }),
  });
  const patched = await patchRes.json();
  check('PATCH updates name', patched.name === 'Daily test renamed');
  check('PATCH updates active', patched.active === false);

  const deleteRes = await fetch(`${wsBase}/recurring/${rule.id}`, { method: 'DELETE', headers });
  check('DELETE returns 204', deleteRes.status === 204);

  // 3. Import preview + commit + rollback
  console.log('\n[import]');
  const fixture = readFileSync(resolve(ROOT, 'fixtures/imports/alfa-sample.xlsx'));
  const previewForm = new FormData();
  previewForm.append('file', new Blob([fixture]), 'alfa-sample.xlsx');
  const previewRes = await fetch(`${wsBase}/import/preview?accountId=${account.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: previewForm,
  });
  const preview = await previewRes.json();
  check(`preview ok (status=${previewRes.status})`, previewRes.status === 201 || previewRes.status === 200);
  check(`preview detected ALFA_XLSX (got ${preview.source})`, preview.source === 'ALFA_XLSX');
  check(`preview has rows (got ${preview.rows?.length})`, preview.rows?.length > 0);
  check('preview stats.duplicates = 0 on first run', preview.stats.duplicates === 0);

  const commitRes = await fetch(`${wsBase}/import/commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filename: preview.filename,
      fileHash: preview.fileHash,
      source: preview.source,
      accountId: account.id,
      skipDuplicates: true,
      rows: preview.rows.map((r) => ({
        date: r.date,
        amount: r.amount,
        type: r.type,
        description: r.description,
        counterpartyName: r.counterpartyName,
        categoryId: null,
        importHash: r.importHash,
        isDuplicate: r.isDuplicate,
      })),
    }),
  });
  const commitResult = await commitRes.json();
  check(`commit ok (status=${commitRes.status})`, commitRes.status === 201);
  check(`commit imported ${preview.rows.length} (got ${commitResult.imported})`, commitResult.imported === preview.rows.length);

  // Re-preview same file → all duplicates
  const previewForm2 = new FormData();
  previewForm2.append('file', new Blob([fixture]), 'alfa-sample.xlsx');
  const preview2Res = await fetch(`${wsBase}/import/preview?accountId=${account.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: previewForm2,
  });
  const preview2 = await preview2Res.json();
  check(
    `re-preview: all rows marked duplicate (${preview2.stats.duplicates}/${preview2.rows.length})`,
    preview2.stats.duplicates === preview2.rows.length,
  );

  // List batches
  const batchesRes = await fetch(`${wsBase}/import/batches`, { headers });
  const batches = await batchesRes.json();
  check('GET /import/batches returns 1 batch', batches.length === 1);

  // Rollback
  const rollbackRes = await fetch(`${wsBase}/import/batches/${commitResult.batchId}/rollback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const rollback = await rollbackRes.json();
  check(`rollback returns 201 (status=${rollbackRes.status})`, rollbackRes.status === 201);
  check(`rollback rolledBack=${commitResult.imported} (got ${rollback.rolledBack})`, rollback.rolledBack === commitResult.imported);

  // After rollback, transactions soft-deleted
  const liveAfterRollback = await prisma.transaction.count({
    where: { importBatchId: commitResult.batchId, deletedAt: null },
  });
  check(`0 live tx after rollback (got ${liveAfterRollback})`, liveAfterRollback === 0);

  // Re-preview after rollback → no duplicates (rolled-back tx don't count)
  const previewForm3 = new FormData();
  previewForm3.append('file', new Blob([fixture]), 'alfa-sample.xlsx');
  const preview3Res = await fetch(`${wsBase}/import/preview?accountId=${account.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: previewForm3,
  });
  const preview3 = await preview3Res.json();
  check(
    `re-preview after rollback: 0 dups (got ${preview3.stats.duplicates})`,
    preview3.stats.duplicates === 0,
  );

  // 4. Cleanup
  console.log('\n[cleanup]');
  await prisma.transaction.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.importBatch.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.counterparty.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.category.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.account.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.recurringRule.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.workspace.delete({ where: { id: workspace.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log('  cleaned');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main()
  .catch(async (e) => {
    console.error('FATAL:', e);
    process.exit(2);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
