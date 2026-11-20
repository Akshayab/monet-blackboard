// Direct checks of server helpers that are hard to reach through the browser, against the dev database.
//   pnpm --filter @monet/scripts exec tsx e2e/rooms-check.mjs
// - a board whose room failed to load (database blip) can be opened again
// - pgSafe / copyTitle edge cases
const { db, usersTable, boardsTable } = await import('../../lib/db/src/index.ts');
const { eq } = await import('drizzle-orm');
const rooms = await import('../../apps/server/src/realtime/rooms.ts');
const { pgSafe, pgSafeText } = await import('../../apps/server/src/lib/pg-safe.ts');
const { copyTitle } = await import('../../apps/server/src/routes/boards.ts');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// pgSafe
check('NUL removed', pgSafeText('a\u0000b') === 'ab');
check('lone high surrogate replaced', pgSafeText('x\ud83d') === 'x\ufffd');
check('lone low surrogate replaced', pgSafeText('\ude00y') === '\ufffdy');
check('real emoji kept', pgSafeText('ok 😀') === 'ok 😀');
const clean = { a: [1, 'x', { b: 'y' }] };
check('clean values keep their reference', pgSafe(clean) === clean);
const dirty = pgSafe({ t: 'a\u0000', n: 1, list: ['ok', 'b\u0000'], ['k\u0000']: true });
check('nested strings and keys cleaned', JSON.stringify(dirty) === JSON.stringify({ t: 'a', n: 1, list: ['ok', 'b'], k: true }), dirty);
const proto = pgSafe(JSON.parse('{"__proto__": {"x": "a\\u0000"}}'));
check('__proto__ keys stay plain data', Object.getPrototypeOf(proto) === Object.prototype && proto.__proto__?.x === 'a' && {}.x === undefined, proto);

// copyTitle
check('short title gets (copy)', copyTitle('Plan') === 'Plan (copy)');
const long = copyTitle('L'.repeat(200));
check('200-char title fits 200 with (copy)', [...long].length === 200 && long.endsWith(' (copy)'), long.length);
const emoji = copyTitle('😀'.repeat(200));
check('emoji title is cut on whole characters', [...emoji].length === 200 && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji));

// A failed room load must not be cached.
const [user] = await db
  .insert(usersTable)
  .values({ id: `guest_rooms_${Date.now().toString(36)}`, displayName: 'rooms', kind: 'guest' })
  .returning();
const [board] = await db
  .insert(boardsTable)
  .values({ ownerId: user.id, title: 'Rooms check', elements: [{ id: 'r1', type: 'rectangle', version: 1, versionNonce: 1 }] })
  .returning();
try {
  const realSelect = db.select;
  db.select = () => {
    db.select = realSelect;
    throw new Error('simulated database blip');
  };
  let firstFailed = false;
  try {
    await rooms.getRoom(board.id);
  } catch {
    firstFailed = true;
  }
  check('first load fails during the blip', firstFailed);
  let second = null;
  try {
    second = await rooms.getRoom(board.id);
  } catch (err) {
    check('board opens once the database is back', false, String(err));
  }
  if (second) check('board opens once the database is back', second.elements.has('r1'));
  if (second) rooms.evictRoom(board.id);
} finally {
  await db.delete(boardsTable).where(eq(boardsTable.id, board.id));
  await db.delete(usersTable).where(eq(usersTable.id, user.id));
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
