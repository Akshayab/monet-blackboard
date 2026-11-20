// Security regression checks for the Monet Blackboard API in team mode: the owner, two guests and a stranger.
//
//   BASE_URL=http://localhost:8099 OWNER_LINK_TOKEN=sec-owner-token node scripts/e2e/security-api.mjs
//
// Run it against a dedicated server (in-memory rate limits accumulate, and the test deliberately trips the
// owner-link and AI limits). Example:
//   TEAM_MODE=1 OWNER_LINK_TOKEN=sec-owner-token PORT=8099 AI_MOCK=1 RATE_AUTH_PER_IP_PER_MIN=40 \
//     RATE_AI_REQUESTS_PER_MIN=4 WS_REVALIDATE_MS=2000 node apps/server/dist/index.mjs
// Talks to the server directly over http (the session cookie is read from Set-Cookie and sent by hand).

const BASE = (process.env.BASE_URL ?? 'http://localhost:8099').replace(/\/$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/api/ws';
const OWNER_TOKEN = process.env.OWNER_LINK_TOKEN ?? 'sec-owner-token';
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}
const section = (s) => console.log(`\n${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.sid = null;
  }
  get cookie() {
    return this.sid ? `sid=${this.sid}` : undefined;
  }
  async req(method, path, { json, body, headers = {}, link, redirect = 'follow' } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (link) h['x-board-link'] = link;
    let payload = body;
    if (json !== undefined) {
      h['content-type'] ??= 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch(BASE + '/api' + path, { method, headers: h, body: payload, redirect });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^sid=([^;]*)/.exec(c);
      if (m) this.sid = m[1] || null;
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    return { status: res.status, data, headers: res.headers };
  }
  claim(token = OWNER_TOKEN) {
    return this.req('POST', '/auth/claim', { json: { token } });
  }
  join(linkToken, name = this.name) {
    return this.req('POST', '/auth/guest', { json: { name, linkToken } });
  }
  /** Opens a board socket. Resolves once init/error/close arrives. */
  openSocket(boardId, link, { origin } = {}) {
    return new Promise((resolve) => {
      const headers = {};
      if (this.cookie) headers.cookie = this.cookie;
      if (origin) headers.origin = origin;
      const ws = new WebSocket(WS_URL, { headers });
      const s = { ws, messages: [], init: null, closed: null, error: false };
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve(s);
        }
      };
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', boardId, linkToken: link ?? null }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        s.messages.push(msg);
        if (msg.t === 'init') {
          s.init = msg;
          done();
        }
      };
      ws.onerror = () => {
        s.error = true;
      };
      ws.onclose = (ev) => {
        s.closed = { code: ev.code, reason: ev.reason };
        done();
      };
      setTimeout(done, 5000);
    });
  }
}

function el(id, extra = {}) {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    roughness: 1,
    opacity: 100,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: 'a0',
    updated: Date.now(),
    link: null,
    ...extra,
  };
}

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
const O = new Client('Owner');
const B = new Client('Bob Sec');
const C = new Client('Cara Sec');

section('Headers');
{
  const r = await O.req('GET', '/healthz');
  check('healthz responds', r.status === 200, r.status);
  check('X-Frame-Options DENY', r.headers.get('x-frame-options') === 'DENY');
  check('nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  check('API CSP denies framing', /frame-ancestors 'none'/.test(r.headers.get('content-security-policy') ?? ''));
  check('Referrer-Policy set', r.headers.get('referrer-policy') === 'strict-origin-when-cross-origin');
  check('no X-Powered-By', !r.headers.get('x-powered-by'));
  check(
    'no CORS allow-origin for foreign origin',
    !(await O.req('GET', '/healthz', { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'),
  );
  const me = await new Client('anon').req('GET', '/auth/user');
  check('server is in team mode', me.data.mode === 'team', me.data);
}

section('Owner link');
{
  const wrong = await O.claim('not-the-owner-token');
  check('wrong owner link refused (403)', wrong.status === 403, wrong.status);
  check('no session from a wrong owner link', !O.sid);
  const ok = await O.claim();
  check('owner link works', ok.status === 200 && ok.data.user?.kind === 'owner', ok.data);
  const first = O.sid;
  await O.claim();
  check('claiming again issues a new session id', O.sid && O.sid !== first);
  const stale = new Client('stale');
  stale.sid = first;
  check('the replaced session is gone', (await stale.req('GET', '/auth/user')).data.user === null);
}

section('Guests need a working share link');
let boardId;
let otherBoard;
{
  const anon = await new Client('anon').req('POST', '/boards', { json: { title: 'x' } });
  check('no session: board creation refused (401)', anon.status === 401, anon.status);
  const bogus = await B.join('not-a-real-link');
  check('join with an unknown link refused (404)', bogus.status === 404, bogus.status);
  check('no session from a failed join', !B.sid);
  const r2 = await O.req('POST', '/boards', { json: { title: "Cara's board" } });
  otherBoard = r2.data.board.id;
  await O.req('PATCH', `/boards/${otherBoard}`, { json: { linkAccess: 'view' } });
  const otherToken = (await O.req('GET', `/boards/${otherBoard}`)).data.board.linkToken;
  const offJoin = await O.req('POST', '/boards', { json: { title: 'Link off' } });
  const offToken = (await O.req('GET', `/boards/${offJoin.data.board.id}`)).data.board.linkToken;
  check('join with a link that is turned off refused', (await new Client('x').join(offToken)).status === 404);
  const cj = await C.join(otherToken);
  check("Cara joins another board's link", cj.status === 201 && cj.data.user?.kind === 'guest', cj);
  check("a guest can't create boards (403)", (await C.req('POST', '/boards', { json: { title: 'mine' } })).status === 403);
  check("a guest can't claim the owner link with a wrong token", (await C.claim('guess')).status === 403);
  const oldSid = C.sid;
  await C.req('POST', '/auth/logout');
  const stale = new Client('stale');
  stale.sid = oldSid;
  check('old guest session rejected after logout', (await stale.req('GET', '/auth/user')).data.user === null);
  await C.join(otherToken);
  check('Cara rejoins with a new session', C.sid && C.sid !== oldSid);
}

section('Board creation sanitizes elements');
{
  const r = await O.req('POST', '/boards', {
    json: {
      title: 'Security test',
      elements: [el('good-1'), el('bad-link', { link: ' JaVaScRiPt:alert(1)' }), { id: 'no-version', type: 'rectangle' }, el('bad-type', { type: 'script' })],
    },
  });
  check('owner creates board', r.status === 201, r);
  boardId = r.data.board.id;
  const b = await O.req('GET', `/boards/${boardId}`);
  const ids = b.data.elements.map((e) => e.id).sort();
  check('invalid elements dropped', JSON.stringify(ids) === JSON.stringify(['bad-link', 'good-1']), ids);
  check('javascript: link neutralized', b.data.elements.find((e) => e.id === 'bad-link')?.link === null);
  check('owner sees link token', typeof b.data.board.linkToken === 'string');
}

section('No access without membership or link');
{
  const checks = [
    ['GET board', 'GET', `/boards/${boardId}`, [404]],
    ['PATCH board', 'PATCH', `/boards/${boardId}`, [403, 404], { title: 'pwned' }],
    ['DELETE board', 'DELETE', `/boards/${boardId}`, [403, 404]],
    ['duplicate', 'POST', `/boards/${boardId}/duplicate`, [403, 404]],
    ['list files', 'GET', `/boards/${boardId}/files`, [404]],
    ['upload file', 'POST', `/boards/${boardId}/files`, [403, 404], { fileId: 'f1', mimeType: 'image/png', dataURL: PNG_1PX }],
    ['members', 'GET', `/boards/${boardId}/members`, [404]],
    ['sharing', 'GET', `/boards/${boardId}/sharing`, [403, 404]],
    ['AI messages', 'GET', `/boards/${boardId}/ai/messages`, [404]],
    ['start AI', 'POST', `/boards/${boardId}/ai`, [403, 404], { prompt: 'hi' }],
  ];
  for (const [name, method, path, ok, json] of checks) {
    const r = await C.req(method, path, json ? { json } : {});
    check(`guest of another board: ${name} -> ${ok.join('/')}`, ok.includes(r.status), r.status);
  }
  const still = await O.req('GET', `/boards/${boardId}`);
  check('board untouched', still.status === 200 && still.data.board.title === 'Security test');
  const ws = await C.openSocket(boardId);
  check('stranger socket refused (4403)', ws.closed?.code === 4403, ws.closed);
  const bad = await C.openSocket(boardId, 'not-the-token');
  check('wrong link token refused', bad.closed?.code === 4403, bad.closed);
}

section('Files');
{
  const notImage = await O.req('POST', `/boards/${boardId}/files`, {
    json: { fileId: 'html', mimeType: 'text/html', dataURL: 'data:text/html,<script>alert(1)</script>' },
  });
  check('non-image file rejected', notImage.status === 400, notImage);
  const mismatch = await O.req('POST', `/boards/${boardId}/files`, {
    json: { fileId: 'mm', mimeType: 'image/png', dataURL: 'data:text/html;base64,PHNjcmlwdD4=' },
  });
  check('data URL must match mime type', mismatch.status === 400, mismatch);
  const ok = await O.req('POST', `/boards/${boardId}/files`, { json: { fileId: 'img-1', mimeType: 'image/png', dataURL: PNG_1PX } });
  check('image upload works', ok.status === 201, ok);
  const cross = await O.req('GET', `/boards/${otherBoard}/files?ids=img-1`);
  check("files don't leak across boards", cross.status === 200 && cross.data.files.length === 0, cross.data);
  const thumb = await O.req('PATCH', `/boards/${boardId}`, { json: { thumbnail: 'https://tracker.example/pixel.png' } });
  check('remote thumbnail URL rejected', thumb.status === 400, thumb);
}

section('View link');
let linkToken;
{
  const r = await O.req('PATCH', `/boards/${boardId}`, { json: { linkAccess: 'view' } });
  check('owner enables view link', r.status === 200);
  linkToken = (await O.req('GET', `/boards/${boardId}`)).data.board.linkToken;
  const joined = await B.join(linkToken);
  check('Bob joins through the view link', joined.status === 201, joined);
  const g = await B.req('GET', `/boards/${boardId}`, { link: linkToken });
  check('viewer can read via link', g.status === 200 && g.data.board.role === 'viewer', g.status);
  check("viewer doesn't see link token", g.data.board?.linkToken === undefined);
  check("viewer can't rename", (await B.req('PATCH', `/boards/${boardId}`, { json: { title: 'x' }, link: linkToken })).status === 403);
  check("viewer can't change sharing", (await B.req('PATCH', `/boards/${boardId}/link`, { json: { access: 'edit' }, link: linkToken })).status === 403);
  check(
    "viewer can't change roles",
    (await B.req('PATCH', `/boards/${boardId}/members/${joined.data.user.id}`, { json: { role: 'editor' }, link: linkToken })).status === 403,
  );
  check(
    "viewer can't upload",
    (await B.req('POST', `/boards/${boardId}/files`, { json: { fileId: 'v1', mimeType: 'image/png', dataURL: PNG_1PX }, link: linkToken })).status === 403,
  );
  check("viewer can't run AI", (await B.req('POST', `/boards/${boardId}/ai`, { json: { prompt: 'hi' }, link: linkToken })).status === 403);
  const share = await B.req('GET', `/share/${linkToken}`);
  check('share resolve works', share.status === 200 && share.data.boardId === boardId);

  const ws = await B.openSocket(boardId, linkToken);
  check('viewer socket joins', ws.init?.board.role === 'viewer', ws.closed);
  ws.ws.send(JSON.stringify({ t: 'elements', elements: [el('viewer-el')] }));
  const got = await waitFor(() => ws.messages.some((m) => m.t === 'error' && m.code === 'read_only'));
  check('viewer elements refused (read_only)', got);
  const after = await O.req('GET', `/boards/${boardId}`);
  check('viewer element not saved', !after.data.elements.some((e) => e.id === 'viewer-el'));
  ws.ws.close();
}

section('Edit link, downgrade and revocation');
{
  await O.req('PATCH', `/boards/${boardId}`, { json: { linkAccess: 'edit' } });
  const rename = await B.req('PATCH', `/boards/${boardId}`, { json: { title: 'Renamed by link editor' }, link: linkToken });
  check('link editor can rename', rename.status === 200, rename.status);
  check("link editor can't change sharing", (await B.req('PATCH', `/boards/${boardId}/link`, { json: { access: 'none' }, link: linkToken })).status === 403);
  // For anyone but the owner, DELETE means "leave this board"; the board itself must survive.
  const leave = await B.req('DELETE', `/boards/${boardId}`, { link: linkToken });
  check("link editor's delete only leaves the board", leave.status === 200 && leave.data.left === true, leave.data);
  check('the board still exists for the owner', (await O.req('GET', `/boards/${boardId}`)).status === 200);

  const ws = await B.openSocket(boardId, linkToken);
  check('editor socket joins', ws.init?.board.role === 'editor');
  ws.ws.send(JSON.stringify({ t: 'elements', elements: [el('editor-el', { index: 'a5' })] }));
  check('editor element saved', await waitFor(async () => (await O.req('GET', `/boards/${boardId}`)).data.elements.some((e) => e.id === 'editor-el')));

  await O.req('PATCH', `/boards/${boardId}`, { json: { linkAccess: 'view' } });
  const downgraded = await waitFor(() => ws.messages.some((m) => m.t === 'board' && m.role === 'viewer'));
  check('live socket downgraded to viewer when link becomes view-only', downgraded);
  ws.ws.send(JSON.stringify({ t: 'elements', elements: [el('after-downgrade', { index: 'a6' })] }));
  check("downgraded socket can't edit", await waitFor(() => ws.messages.some((m) => m.t === 'error' && m.code === 'read_only')));

  // Bob joined through the link, so he is a link member. Turning the link off must cut him off everywhere.
  await O.req('PATCH', `/boards/${boardId}`, { json: { linkAccess: 'none' } });
  const closed = await waitFor(() => ws.closed?.code === 4403);
  check('live socket closed when link is turned off', closed, ws.closed);
  const noLink = await B.req('GET', `/boards/${boardId}`);
  check('link member loses access without the link', noLink.status === 404, noLink.status);
  const withLink = await B.req('GET', `/boards/${boardId}`, { link: linkToken });
  check('old link no longer works', withLink.status === 404, withLink.status);
  const lib = await B.req('GET', '/boards');
  check("board gone from the guest's library", !lib.data.boards.some((b) => b.id === boardId));
  const shareDead = await B.req('GET', `/share/${linkToken}`);
  check('share resolve 404 when link is off', shareDead.status === 404);

  // A new link after regenerating: the old token stays dead.
  await O.req('PATCH', `/boards/${boardId}`, { json: { linkAccess: 'view' } });
  const regen = await O.req('POST', `/boards/${boardId}/link/regenerate`, { json: {} });
  const fresh = (await O.req('GET', `/boards/${boardId}`)).data.board.linkToken;
  check('regenerate issues a new link', regen.status === 200 && fresh && fresh !== linkToken, regen.status);
  check('the old link is dead after regenerating', (await B.req('GET', `/share/${linkToken}`)).status === 404);
}

section('CSRF and content types');
{
  const textPlain = await O.req('POST', '/boards', { body: JSON.stringify({ title: 'csrf' }), headers: { 'content-type': 'text/plain' } });
  check('text/plain POST rejected (415)', textPlain.status === 415, textPlain.status);
  const form = await O.req('POST', '/auth/logout', { body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  check('form POST rejected (415)', form.status === 415, form.status);
  const foreign = await O.req('POST', '/boards', { json: { title: 'csrf' }, headers: { origin: 'https://evil.example' } });
  check('foreign Origin rejected (403)', foreign.status === 403, foreign.status);
  const nullOrigin = await O.req('DELETE', `/boards/${otherBoard}`, { headers: { origin: 'null' } });
  check('Origin: null rejected (403)', nullOrigin.status === 403, nullOrigin.status);
  const crossSite = await O.req('PATCH', `/boards/${otherBoard}`, { json: { title: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
  check('Sec-Fetch-Site cross-site rejected', crossSite.status === 403, crossSite.status);
  const same = await O.req('PATCH', `/boards/${otherBoard}`, { json: { title: 'same origin ok' }, headers: { origin: BASE } });
  check('same-origin JSON accepted', same.status === 200, same.status);
  const me = await O.req('GET', '/auth/user');
  check('owner still signed in after blocked logout', me.data.user?.kind === 'owner');
  const ws = await O.openSocket(boardId, null, { origin: 'https://evil.example' });
  check('WebSocket from foreign origin refused', !ws.init && (ws.error || ws.closed), ws.closed);
}

section('Body limits and error format');
{
  const big = await new Client('x').req('POST', '/auth/claim', { json: { token: 'p'.repeat(100_000) } });
  check('oversize owner-link body -> 413 JSON', big.status === 413 && typeof big.data.error === 'string', big);
  const badJson = await O.req('POST', '/boards', { body: '{not json', headers: { 'content-type': 'application/json' } });
  check('malformed JSON -> 400 JSON', badJson.status === 400 && typeof badJson.data.error === 'string', badJson);
}

section('WebSocket limits');
{
  const ws = await O.openSocket(otherBoard);
  check('owner socket joins', !!ws.init);
  const many = Array.from({ length: 5001 }, (_, i) => el(`m${i}`));
  ws.ws.send(JSON.stringify({ t: 'elements', elements: many }));
  check('more than 5000 elements in one message refused', await waitFor(() => ws.messages.some((m) => m.t === 'error' && m.code === 'too_many_elements')));
  ws.ws.send(JSON.stringify({ t: 'elements', elements: [el('huge', { type: 'text', text: 'x'.repeat(1_100_000), index: 'a1' })] }));
  ws.ws.send(JSON.stringify({ t: 'elements', elements: [el('bad-version', { version: '9' })] }));
  ws.ws.send(JSON.stringify({ t: 'hello', boardId })); // second hello is ignored
  await sleep(500);
  const state = await O.req('GET', `/boards/${otherBoard}`);
  check('oversize element dropped', !state.data.elements.some((e) => e.id === 'huge'));
  check('non-numeric version dropped', !state.data.elements.some((e) => e.id === 'bad-version'));
  check('second hello ignored (socket still open)', !ws.closed);
  for (let i = 0; i < 120; i++) ws.ws.send(JSON.stringify({ t: 'elements', elements: [el(`flood-${i}`, { version: i + 2 })] }));
  check('element flood closes socket with 4429', await waitFor(() => ws.closed?.code === 4429), ws.closed);
}

section('AI request limits');
{
  let limited = null;
  for (let i = 0; i < 30 && !limited; i++) {
    const r = await O.req('POST', `/boards/${otherBoard}/ai`, { json: { prompt: `test ${i}` } });
    if (r.status === 429) limited = r;
  }
  check('AI endpoint rate-limited', !!limited && !!limited.headers.get('retry-after'), limited?.status);
  await O.req('POST', `/boards/${otherBoard}/ai/stop`, { json: {} });
  const usage = await O.req('GET', '/ai/usage');
  const u = usage.data.usage ?? {};
  check('usage endpoint reports limits', typeof u.requestLimit === 'number' && typeof u.tokenLimit === 'number' && typeof u.paused === 'boolean', u);
}

section('Owner link guessing is rate-limited');
{
  const attacker = new Client('attacker');
  let limited = null;
  for (let i = 0; i < 60 && !limited; i++) {
    const r = await attacker.claim(`guess-${i}`);
    if (r.status === 429) limited = r;
    else if (r.status !== 403) check(`guess ${i} refused`, false, r.status);
  }
  check('repeated wrong owner links hit 429 with Retry-After', !!limited && !!limited.headers.get('retry-after'), limited?.status);
  const right = await attacker.claim();
  check('even the right link is refused while limited', right.status === 429, right.status);
  check('no session issued while limited', !attacker.sid);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
