// Direct checks of reserveAi() (apps/server/src/lib/ai-limits.ts) against the dev database.
//   pnpm --filter @monet/scripts exec tsx e2e/ai-limits-check.mjs
// Uses tiny limits via env vars and a throwaway user, and cleans up its rows.
process.env.AI_BOARD_CONCURRENT_LIMIT = '1';
process.env.AI_CONCURRENT_LIMIT = '2';
process.env.AI_IP_HOURLY_LIMIT = '3';
process.env.AI_DAILY_REQUEST_LIMIT = '5';

const { db, usersTable, aiUsageTable } = await import('../../lib/db/src/index.ts');
const { eq } = await import('drizzle-orm');
const limits = await import('../../apps/server/src/lib/ai-limits.ts');
const { runWithRequestContext } = await import('../../apps/server/src/lib/request-context.ts');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
async function code(fn) {
  try {
    await fn();
    return 'ok';
  } catch (e) {
    return e instanceof limits.AiLimitError ? `${e.status}:${e.code}` : `error:${e}`;
  }
}

const [user] = await db
  .insert(usersTable)
  .values({ id: `guest_limits_${Date.now().toString(36)}`, displayName: 'limits', kind: 'guest' })
  .returning();
const uid = user.id;
try {
  // Per-board concurrency (limit 1), board id from the request context.
  const r1 = await runWithRequestContext({ ip: '203.0.113.1', boardId: 'board-1' }, () => limits.reserveAi(uid));
  check('first run on a board reserved', r1.usage.running === 1, r1.usage);
  check(
    'second run on the same board refused',
    (await code(() => runWithRequestContext({ ip: '203.0.113.1', boardId: 'board-1' }, () => limits.reserveAi(uid)))) === '429:board_concurrency',
  );
  // Per-user concurrency (limit 2): a run on another board is fine, a third is refused.
  const r2 = await limits.reserveAi(uid, { boardId: 'board-2', ip: '203.0.113.1' });
  check('third concurrent run refused for the user', (await code(() => limits.reserveAi(uid, { boardId: 'board-3' }))) === '429:user_concurrency');
  const usage = await limits.getAiUsage(uid);
  check('usage reports in-flight runs', usage.running === 2, usage);
  r1.release();
  r1.release(); // idempotent
  r2.release();
  check('slots freed after release', (await limits.getAiUsage(uid)).running === 0);

  // Per-IP hourly cap (limit 3; two hits already counted above).
  const r3 = await limits.reserveAi(uid, { ip: '203.0.113.1' });
  r3.release();
  check('per-IP cap reached', (await code(() => limits.reserveAi(uid, { ip: '203.0.113.1' }))) === '429:ip_limit');
  const r4 = await limits.reserveAi(uid, { ip: '198.51.100.7' });
  r4.release();
  check('other IPs unaffected', true);

  // Daily request limit (5) counts recorded usage plus in-flight runs.
  for (let i = 0; i < 4; i++) await limits.recordAiUsage({ userId: uid, kind: 'test', inputTokens: 10, outputTokens: 5 });
  const r5 = await limits.reserveAi(uid, { ip: '198.51.100.8' });
  check('in-flight run counts toward the daily limit', (await code(() => limits.reserveAi(uid, { ip: '198.51.100.9' }))) === '429:daily_limit');
  r5.release();

  // Kill switch.
  process.env.AI_DISABLED = 'true';
  check('AI_DISABLED refuses every run with 503', (await code(() => limits.reserveAi(uid))) === '503:ai_disabled');
  const paused = await limits.getAiUsage(uid);
  check('usage reports paused/disabled', paused.paused && paused.pausedReason === 'disabled', paused);
  delete process.env.AI_DISABLED;
  check('AI back on when the switch is cleared', !(await limits.getAiUsage(uid)).paused);
} finally {
  await db.delete(aiUsageTable).where(eq(aiUsageTable.userId, uid));
  await db.delete(usersTable).where(eq(usersTable.id, uid));
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
