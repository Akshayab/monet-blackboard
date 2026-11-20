// Stopping a board AI run mid-response (POST /api/boards/:id/ai/stop).
// Run against an API started with AI_MOCK=1 (uses the slow "[dev-script:long]" scenario) or a real AI server:
//   AI_MOCK=1 PORT=8099 NODE_ENV=development node dist/index.mjs &  then  AI_MOCK=1 BASE=http://localhost:8099 node test/ai-stop-check.mjs
// Checks: a non-editor gets 403; after the first AI elements land, stop ends the run within ~2 s with a
// t:"ai" status "stopped" frame; what was drawn stays and nothing more is drawn; the chat records "Stopped."
// with meta.stopped/stoppedBy; stopping again reports { stopped: false }; a new run starts and finishes right after.
import WebSocket from "ws";

const base = process.env.BASE || "http://localhost:8099";
const mock = !!process.env.AI_MOCK;
const H = (c) => ({ "content-type": "application/json", cookie: c, origin: base });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// Identity: in solo mode every localhost request is the owner (no cookie). In team mode, claim the owner link
// (the server must run with OWNER_LINK_TOKEN, default "e2e-owner-token" here) and join guests through share links.
const cookieOf = (r) =>
  (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie")])
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .join("; ");
async function serverMode() {
  return (await (await fetch(base + "/api/auth/user", { headers: { origin: base } })).json()).mode;
}
async function ownerCookie() {
  if ((await serverMode()) === "solo") return "";
  const r = await fetch(base + "/api/auth/claim", {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token: process.env.OWNER_LINK_TOKEN || "e2e-owner-token" }),
  });
  if (r.status !== 200) throw new Error("claim owner " + r.status + " " + (await r.text()));
  return cookieOf(r);
}
async function guestCookie(name, linkToken) {
  const r = await fetch(base + "/api/auth/guest", {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, linkToken }),
  });
  if (r.status >= 300) throw new Error("join as guest " + r.status + " " + (await r.text()));
  return { cookie: cookieOf(r), user: (await r.json()).user };
}

function open(c, boardId) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/api/ws", { headers: { cookie: c.cookie, origin: base } });
    const msgs = [];
    ws.on("message", (d) => msgs.push({ at: Date.now(), ...JSON.parse(d) }));
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", boardId }));
      setTimeout(() => res({ ws, msgs }), 800);
    });
    ws.on("error", rej);
  });
}
const waitFor = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  return null;
};
const aiElementsOnBoard = async (cookie, id) =>
  (await (await fetch(base + `/api/boards/${id}`, { headers: H(cookie) })).json()).elements.filter((e) => !e.isDeleted && e.customData?.createdBy === "ai");

const owner = { cookie: await ownerCookie() };
owner.user = (await (await fetch(base + "/api/auth/user", { headers: H(owner.cookie) })).json()).user;
const { board } = await (await fetch(base + "/api/boards", { method: "POST", headers: H(owner.cookie), body: JSON.stringify({ title: "Stop check" }) })).json();
// The outsider is a guest of a different board (team mode only).
let outsider = null;
if ((await serverMode()) === "team") {
  const { board: other } = await (
    await fetch(base + "/api/boards", { method: "POST", headers: H(owner.cookie), body: JSON.stringify({ title: "Other board" }) })
  ).json();
  await fetch(base + `/api/boards/${other.id}/link`, { method: "PATCH", headers: H(owner.cookie), body: JSON.stringify({ access: "view" }) });
  const tok = (await (await fetch(base + `/api/boards/${other.id}`, { headers: H(owner.cookie) })).json()).board.linkToken;
  outsider = await guestCookie("Outsider", tok);
}
const A = await open(owner, board.id);
console.log("base", base, "· model:", mock ? "scripted test model (AI_MOCK=1)" : "real model");

// No access -> 403.
if (outsider) {
  const denied = await fetch(base + `/api/boards/${board.id}/ai/stop`, { method: "POST", headers: H(outsider.cookie), body: "{}" });
  check("non-editor gets 403", denied.status === 403, `status ${denied.status}`);
}

// Nothing running -> stopped:false.
const idle = await fetch(base + `/api/boards/${board.id}/ai/stop`, { method: "POST", headers: H(owner.cookie), body: "{}" });
const idleBody = await idle.json();
check("stop with no active run reports stopped:false", idle.status === 200 && idleBody.stopped === false, JSON.stringify(idleBody));

// Start a long run.
const prompt = mock
  ? "[dev-script:long] lots of ideas"
  : "Brainstorm a huge launch board: 8 sections (Goals, Audience, Channels, Content, Partnerships, Risks, Budget, Metrics) with 10 detailed stickies each, connections between related ideas, a timeline with 12 milestones, and a budget table.";
const usage0 = await (await fetch(base + "/api/ai/usage", { headers: H(owner.cookie) })).json();
const start = await fetch(base + `/api/boards/${board.id}/ai`, {
  method: "POST",
  headers: H(owner.cookie),
  body: JSON.stringify({ prompt, viewport: { x: 0, y: 0, width: 1400, height: 900 } }),
});
const startBody = await start.json();
check("long run starts", start.status === 202 && !!startBody.runId, `status ${start.status}`);
const runId = startBody.runId;

const firstEls = await waitFor(() => A.msgs.find((m) => m.t === "elements" && m.source === "ai"), mock ? 20_000 : 180_000);
check("first AI elements land", !!firstEls, firstEls ? `${firstEls.elements.length} elements in the first batch` : "none arrived");

// Stop it.
const t0 = Date.now();
const stop = await fetch(base + `/api/boards/${board.id}/ai/stop`, { method: "POST", headers: H(owner.cookie), body: "{}" });
const stopBody = await stop.json();
const stopMs = Date.now() - t0;
check(
  "stop responds stopped:true with the run id",
  stop.status === 200 && stopBody.stopped === true && stopBody.runIds?.includes(runId),
  `${JSON.stringify(stopBody)} in ${stopMs} ms`,
);
const frame = await waitFor(() => A.msgs.find((m) => m.t === "ai" && m.runId === runId && m.status === "stopped"), 5_000);
const endMs = frame ? frame.at - t0 : null;
check(
  'run ends within ~2 s with a "stopped" status frame',
  frame && endMs <= 2_000,
  frame ? `${endMs} ms, stoppedBy ${frame.stoppedBy === owner.user.id ? "the owner" : frame.stoppedBy}` : "no stopped frame",
);
check('no "done"/"error" frame for the stopped run', !A.msgs.some((m) => m.t === "ai" && m.runId === runId && (m.status === "done" || m.status === "error")));

// What was drawn stays, and nothing more is drawn.
const after = await aiElementsOnBoard(owner.cookie, board.id);
await sleep(1_500);
const later = await aiElementsOnBoard(owner.cookie, board.id);
const lateFrames = A.msgs.filter((m) => m.t === "elements" && m.source === "ai" && m.at > (frame?.at ?? t0) + 50).length;
check(
  "elements already placed stay on the board",
  after.length > 0 && later.length === after.length,
  `${after.length} AI elements, ${later.length} after 1.5 s`,
);
check("nothing is drawn after the stop", lateFrames === 0, `${lateFrames} late element batches`);

// Chat history.
const { messages } = await (await fetch(base + `/api/boards/${board.id}/ai/messages`, { headers: H(owner.cookie) })).json();
const stoppedMsg = messages.find((m) => m.role === "assistant" && m.meta?.runId === runId);
check(
  'chat records "Stopped." with meta.stopped and stoppedBy',
  stoppedMsg?.content === "Stopped." && stoppedMsg.meta?.stopped === true && stoppedMsg.meta?.stoppedBy === owner.user.id,
  stoppedMsg ? `${stoppedMsg.content} ${JSON.stringify({ stopped: stoppedMsg.meta?.stopped, created: stoppedMsg.meta?.created })}` : "missing",
);

// Usage counted once (only the tokens actually used).
const usage1 = await (await fetch(base + "/api/ai/usage", { headers: H(owner.cookie) })).json();
check(
  "the stopped run counts as one request",
  usage1.usage.requestsUsed === usage0.usage.requestsUsed + 1,
  `${usage0.usage.requestsUsed} -> ${usage1.usage.requestsUsed}`,
);

// Stopping again: nothing to stop.
const again = await (await fetch(base + `/api/boards/${board.id}/ai/stop`, { method: "POST", headers: H(owner.cookie), body: "{}" })).json();
check("stopping again reports stopped:false", again.stopped === false, JSON.stringify(again));

// A new run can start right after and finish.
const next = await fetch(base + `/api/boards/${board.id}/ai`, {
  method: "POST",
  headers: H(owner.cookie),
  body: JSON.stringify({ prompt: mock ? "Plan a team lunch, pick a venue, invite people" : 'Add one sticky that says "Next step: pick a date".' }),
});
const nextBody = await next.json();
check("a new run starts right after", next.status === 202 && !!nextBody.runId, `status ${next.status}`);
const done = await waitFor(
  () => A.msgs.find((m) => m.t === "ai" && m.runId === nextBody.runId && (m.status === "done" || m.status === "error")),
  mock ? 20_000 : 180_000,
);
check("the new run finishes normally", done?.status === "done", done ? done.status : "timeout");

A.ws.close();
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed: results.length - failed, failed, boardId: board.id }));
process.exit(failed ? 1 : 0);
