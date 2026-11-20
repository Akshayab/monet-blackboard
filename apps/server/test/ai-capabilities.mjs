// Real-model capability check for the board AI: one scenario per thing people ask it to do.
// Start a server with a model key (solo or team mode), then:  BASE=http://localhost:3000 node apps/server/test/ai-capabilities.mjs
// ONLY=P1,W1 runs a subset.
// Each scenario seeds a board over the REST API, asks the AI, waits for its reply in the board chat, and checks the
// board the server saved. Prints one line per scenario and a JSON summary; exit code 1 if any scenario fails.
const base = process.env.BASE || "http://localhost:8099";
const H = (c) => ({ "content-type": "application/json", cookie: c, origin: base });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const IDX = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function el(type, id, x, y, w, h, extra = {}) {
  const i = n++;
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1000 + i,
    version: 1,
    versionNonce: 5000 + i,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    index: "a" + IDX[Math.floor(i / 62)] + IDX[i % 62],
    ...extra,
  };
}
function sticky(id, x, y, text, frameId = null) {
  const t = el("text", `${id}-t`, x + 10, y + 70, 160, 25, {
    text,
    originalText: text,
    containerId: id,
    fontSize: 18,
    fontFamily: 5,
    textAlign: "center",
    verticalAlign: "middle",
    lineHeight: 1.25,
    autoResize: true,
    frameId,
  });
  const r = el("rectangle", id, x, y, 180, 180, {
    backgroundColor: "#ffec99",
    roughness: 0,
    boundElements: [{ id: t.id, type: "text" }],
    customData: { kind: "sticky" },
    frameId,
  });
  return [r, t];
}
const frame = (id, x, y, w, h, name) => el("frame", id, x, y, w, h, { name });
function arrow(id, a, b) {
  return el("arrow", id, a.x + 180, a.y + 90, b.x - a.x - 180, 0, {
    points: [
      [0, 0],
      [b.x - a.x - 180, 0],
    ],
    startBinding: { elementId: a.id, focus: 0, gap: 4 },
    endBinding: { elementId: b.id, focus: 0, gap: 4 },
    startArrowhead: null,
    endArrowhead: "arrow",
    lastCommittedPoint: null,
  });
}
const freedraw = (id, x, y, pts) => el("freedraw", id, x, y, 100, 100, { points: pts, pressures: [], simulatePressure: true, lastCommittedPoint: null });

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

async function board(cookie, title, elements) {
  const r = await fetch(base + "/api/boards", { method: "POST", headers: H(cookie), body: JSON.stringify({ title, elements }) });
  if (r.status !== 201) throw new Error("create board " + r.status + " " + (await r.text()));
  return (await r.json()).board.id;
}
async function elements(cookie, id) {
  return (await (await fetch(base + `/api/boards/${id}`, { headers: H(cookie) })).json()).elements.filter((e) => !e.isDeleted);
}
async function ask(cookie, id, body) {
  const t0 = Date.now();
  const r = await fetch(base + `/api/boards/${id}/ai`, { method: "POST", headers: H(cookie), body: JSON.stringify(body) });
  const txt = await r.text();
  if (r.status !== 202) throw new Error(`POST ai ${r.status} ${txt}`);
  const { runId } = JSON.parse(txt);
  while (Date.now() - t0 < 240_000) {
    const { messages } = await (await fetch(base + `/api/boards/${id}/ai/messages`, { headers: H(cookie) })).json();
    const m = messages.find((x) => x.role === "assistant" && x.meta?.runId === runId);
    if (m)
      return {
        reply: m.content,
        meta: m.meta ?? {},
        sec: Math.round((Date.now() - t0) / 1000),
        user: messages.find((x) => x.role === "user" && x.meta?.runId === runId),
      };
    await sleep(1000);
  }
  throw new Error("AI run timed out");
}
// Labels wrap inside stickies ("Record demo\nvideo"), so compare with whitespace collapsed.
const txt = (els) =>
  els
    .filter((e) => e.type === "text")
    .map((e) => String(e.text ?? "").replace(/\s+/g, " "))
    .join(" | ");
const isAi = (e) => e.customData?.createdBy === "ai";

const results = [];
const only = (process.env.ONLY || "").split(",").filter(Boolean);
async function scenario(item, name, fn) {
  if (only.length && !only.includes(item)) return;
  try {
    const out = await fn();
    results.push({ item, name, pass: !!out.pass, ...out });
    console.log(`${out.pass ? "PASS" : "FAIL"} ${item} ${name} (${out.sec ?? "?"} s): ${out.detail}`);
  } catch (err) {
    results.push({ item, name, pass: false, detail: String(err.message || err) });
    console.log(`FAIL ${item} ${name}: ${err.message || err}`);
  }
}

const cookie = await ownerCookie();
console.log("base", base, "· model: whatever the server is configured with (no test mode)");

await scenario("P1", "messy brain dump → structured board", async () => {
  const id = await board(cookie, "Brain dump", []);
  const r = await ask(cookie, id, {
    prompt:
      "ok so for the offsite: need a venue (maybe Tahoe?), budget around 20k, agenda has strategy day + team building, Sam books travel, Priya owns agenda, also dietary needs survey, swag?, and we have to decide dates soon - either Mar 3-5 or Mar 10-12",
    viewport: { x: 0, y: 0, width: 1400, height: 900 },
  });
  const els = await elements(cookie, id);
  const frames = els.filter((e) => e.type === "frame").length,
    stickies = els.filter((e) => e.customData?.kind === "sticky").length;
  return {
    pass: frames >= 2 && stickies >= 5 && els.every(isAi),
    sec: r.sec,
    detail: `${frames} sections, ${stickies} stickies, ${els.length} elements, all marked createdBy=ai: ${els.every(isAi)}`,
  };
});

await scenario("P2", "timeline with owners and dates", async () => {
  const id = await board(cookie, "Timeline", []);
  const r = await ask(cookie, id, {
    prompt: "Lay out a launch timeline: private beta Jan 10 (Priya), pricing page Jan 17 (Sam), press kit Jan 24 (Lee), launch event Feb 1 (Ana).",
  });
  const t = txt(await elements(cookie, id));
  const owners = ["Priya", "Sam", "Lee", "Ana"].filter((o) => t.includes(o)).length;
  const dates = ["Jan 10", "Jan 17", "Jan 24", "Feb 1"].filter((d) => t.includes(d) || t.includes(d.replace(" ", " 0"))).length;
  return { pass: owners === 4 && dates >= 3, sec: r.sec, detail: `owners on board ${owners}/4, dates ${dates}/4` };
});

await scenario("P3", "turn the board into a timeline", async () => {
  const seed = [
    ...sticky("s1", 0, 0, "Ship beta - Jan 10"),
    ...sticky("s2", 220, 0, "Pricing live - Jan 17"),
    ...sticky("s3", 440, 0, "Press day - Jan 24"),
    ...sticky("s4", 660, 0, "Launch - Feb 1"),
  ];
  const id = await board(cookie, "To timeline", seed);
  const r = await ask(cookie, id, { prompt: "Turn this board into a timeline." });
  const els = await elements(cookie, id);
  const ai = els.filter(isAi);
  const hasAxis = ai.some((e) => e.type === "line" || e.type === "arrow");
  return {
    pass: ai.length >= 4 && hasAxis,
    sec: r.sec,
    detail: `${ai.length} AI elements, axis/line drawn: ${hasAxis}, status reply: "${r.reply.slice(0, 80)}"`,
  };
});

await scenario("P4", "find the gaps → suggestions to check", async () => {
  const [a, at] = sticky("g1", 0, 0, "User signs up");
  const [b, bt] = sticky("g2", 900, 0, "User shares first board");
  const id = await board(cookie, "Gaps", [a, at, b, bt, arrow("g-arrow", a, b)]);
  const r = await ask(cookie, id, { prompt: "What's missing between these two steps?" });
  const sugg = (await elements(cookie, id)).filter((e) => e.customData?.suggestion);
  return { pass: sugg.length >= 2, sec: r.sec, detail: `${sugg.length} suggestion elements (dashed, for people to accept or dismiss)` };
});

await scenario("P5", "focus on one area", async () => {
  const left = [...sticky("f1", 0, 0, "Onboarding emails"), ...sticky("f2", 0, 220, "Welcome checklist")];
  const right = [...sticky("f3", 1600, 0, "Office snacks"), ...sticky("f4", 1600, 220, "Parking passes")];
  const id = await board(cookie, "Focus", [...left, ...right]);
  // Compare against the board as loaded (older boards get their colors updated for the dark canvas on load).
  const loaded = await elements(cookie, id);
  const r = await ask(cookie, id, { prompt: "Add two more ideas that fit with these.", focusElementIds: ["f1", "f1-t", "f2", "f2-t"] });
  const els = await elements(cookie, id);
  const untouched = ["f3", "f4", "f3-t", "f4-t"].every((k) => {
    const e = els.find((x) => x.id === k);
    return e && e.version === loaded.find((x) => x.id === k)?.version;
  });
  const added = els.filter(isAi).length;
  return {
    pass: added >= 2 && untouched && r.user?.meta?.focusCount === 2,
    sec: r.sec,
    detail: `${added} AI elements added, unselected items untouched: ${untouched}, chat says "About ${r.user?.meta?.focusCount} items"`,
  };
});

await scenario("P6", "retro: group by theme, action items per person", async () => {
  const notes = [
    "Ana: deploys were slow",
    "Ben: CI flaky again",
    "Ana: great pairing on search",
    "Cy: unclear priorities",
    "Ben: loved the demo day",
    "Cy: too many meetings",
  ];
  const seed = notes.flatMap((t, i) => sticky(`r${i}`, (i % 3) * 220, Math.floor(i / 3) * 220, t));
  const id = await board(cookie, "Retro", seed);
  const r = await ask(cookie, id, { prompt: "Run our retro: group these notes by theme and draft action items for each person." });
  const els = await elements(cookie, id);
  const frames = els.filter((e) => e.type === "frame").map((e) => e.name || e.customData?.sectionTitle || "");
  const t = txt(els.filter(isAi));
  const people = ["Ana", "Ben", "Cy"].filter((p) => t.includes(p)).length;
  return { pass: frames.length >= 2 && people === 3, sec: r.sec, detail: `sections: ${frames.join(", ")}; action items mention ${people}/3 people` };
});

await scenario("P7", "revise a section in place", async () => {
  const fr = frame("risk-frame", -40, -80, 520, 300, "Risks");
  const seed = [fr, ...sticky("k1", 0, 0, "Vendor delays", "risk-frame"), ...sticky("k2", 240, 0, "Low beta signups", "risk-frame")];
  const id = await board(cookie, "Revise", seed);
  const r = await ask(cookie, id, { prompt: "Revise the Risks section in place: add a short mitigation to each risk." });
  const els = await elements(cookie, id);
  const riskFrames = els.filter((e) => e.type === "frame" && /risk/i.test(e.name || e.customData?.sectionTitle || "")).length;
  const changed =
    els.filter((e) => ["k1", "k2", "k1-t", "k2-t", "risk-frame"].includes(e.id) && e.version > 1).length +
    els.filter((e) => isAi(e) && e.frameId === "risk-frame").length;
  return {
    pass: riskFrames === 1 && changed >= 1,
    sec: r.sec,
    detail: `Risks sections: ${riskFrames} (no duplicate), items changed or added inside it: ${changed}`,
  };
});

await scenario("P8", "visual explainer: stat cards and a chart", async () => {
  const id = await board(cookie, "Explainer", []);
  const r = await ask(cookie, id, {
    prompt: "Make a visual explainer of our Q3: signups 12,400 (+18%), activation 41%, revenue $86k. Monthly signups: Jul 3800, Aug 4100, Sep 4500.",
  });
  const els = await elements(cookie, id);
  const stats = new Set(els.filter((e) => e.customData?.aiKind === "stat-card").flatMap((e) => e.groupIds || [])).size;
  const chart = els.some((e) => /chart/i.test(JSON.stringify(e.customData || {})));
  const t = txt(els);
  return {
    pass: (stats >= 2 || chart) && /12,?400/.test(t),
    sec: r.sec,
    detail: `stat-card groups: ${stats}, chart elements: ${chart}, real numbers on board: ${/12,?400/.test(t)}`,
  };
});

await scenario("P9", "summarize the board", async () => {
  const seed = [
    ...sticky("m1", 0, 0, "Users want dark mode"),
    ...sticky("m2", 220, 0, "Export is too slow"),
    ...sticky("m3", 440, 0, "Dark mode requested 14 times"),
  ];
  const id = await board(cookie, "Summary", seed);
  const r = await ask(cookie, id, { prompt: "Summarize this board's findings." });
  return { pass: r.reply.length > 40 && /dark mode/i.test(r.reply), sec: r.sec, detail: `reply: "${r.reply.slice(0, 140)}"` };
});

await scenario("P10", "CSV upload → structured board", async () => {
  const csv =
    "task,owner,status\nWrite launch post,Priya,in progress\nRecord demo video,Sam,todo\nUpdate pricing page,Lee,done\nBook launch venue,Ana,todo\nPress outreach,Lee,in progress";
  const id = await board(cookie, "CSV", []);
  const r = await ask(cookie, id, { prompt: "Turn this file into a structured board.", attachments: [{ name: "tasks.csv", mimeType: "text/csv", text: csv }] });
  const els = await elements(cookie, id);
  const t = txt(els);
  const tasks = ["launch post", "demo video", "pricing page", "venue", "Press outreach"].filter((k) => t.toLowerCase().includes(k.toLowerCase())).length;
  return {
    pass: tasks >= 4 && els.length >= 8,
    sec: r.sec,
    detail: `${els.length} elements; ${tasks}/5 CSV tasks on the board; chat shows file ${JSON.stringify(r.user?.meta?.attachments)}`,
  };
});

await scenario("P11", "sketch → clean shapes", async () => {
  const seed = [
    freedraw("k-box1", 0, 0, [
      [0, 0],
      [120, 2],
      [118, 80],
      [2, 78],
      [0, 0],
    ]),
    freedraw("k-line", 130, 40, [
      [0, 0],
      [60, 1],
      [120, 0],
    ]),
    freedraw("k-box2", 260, 0, [
      [0, 0],
      [120, 3],
      [119, 82],
      [1, 79],
      [0, 0],
    ]),
    el("text", "k-l1", 20, 25, 80, 25, {
      text: "Login",
      originalText: "Login",
      fontSize: 20,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "top",
      lineHeight: 1.25,
      containerId: null,
      autoResize: true,
    }),
    el("text", "k-l2", 280, 25, 90, 25, {
      text: "Dashboard",
      originalText: "Dashboard",
      fontSize: 20,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "top",
      lineHeight: 1.25,
      containerId: null,
      autoResize: true,
    }),
  ];
  const id = await board(cookie, "Sketch", seed);
  const r = await ask(cookie, id, { prompt: "Clean up this sketch into proper shapes and connectors.", focusElementIds: seed.map((e) => e.id) });
  const els = await elements(cookie, id);
  const shapes = els.filter((e) => isAi(e) && ["rectangle", "ellipse", "diamond"].includes(e.type)).length;
  const conn = els.some((e) => isAi(e) && e.type === "arrow");
  return { pass: shapes >= 2 && conn, sec: r.sec, detail: `${shapes} clean shapes, connector: ${conn}, labels: ${txt(els.filter(isAi)).slice(0, 80)}` };
});

await scenario("P12", "live listening: board builds from transcript chunks without duplicates", async () => {
  const id = await board(cookie, "Meeting", []);
  const r1 = await ask(cookie, id, {
    mode: "live",
    prompt:
      "Ana: ok let's plan the Q1 roadmap. Ben: search revamp has to come first, I can own it. Cy: I'll take the mobile app polish, targeting end of February.",
  });
  const after1 = (await elements(cookie, id)).length;
  const r2 = await ask(cookie, id, {
    mode: "live",
    prompt: "Ana: agreed. Also we need SSO for enterprise, Ana owns that, due March 15. Ben: and search should ship by Jan 31.",
  });
  const els = await elements(cookie, id);
  const t = txt(els);
  const dupSearch = els.filter((e) => e.type === "text" && /search revamp/i.test(e.text)).length;
  return {
    pass: after1 > 0 && els.length > after1 && /SSO/i.test(t) && dupSearch <= 1,
    sec: r1.sec + r2.sec,
    detail: `chunk 1 → ${after1} elements, chunk 2 → ${els.length}; SSO added: ${/SSO/i.test(t)}; "search revamp" items: ${dupSearch} (${els
      .filter((e) => e.type === "text" && /search revamp/i.test(e.text))
      .map((e) => JSON.stringify(e.text.replace(/\n/g, " ").slice(0, 50)))
      .join(", ")}); live badge: ${r1.user?.meta?.mode}`,
  };
});

async function generate(kind) {
  const seed = [
    ...sticky("d1", 0, 0, "Goal: 500 beta users"),
    ...sticky("d2", 220, 0, "Pricing: $12/seat"),
    ...sticky("d3", 440, 0, "Launch Feb 1"),
    ...sticky("d4", 660, 0, "Risk: vendor delays"),
  ];
  const id = await board(cookie, kind === "doc" ? "Doc source" : "Deck source", seed);
  const t0 = Date.now();
  const r = await fetch(base + `/api/boards/${id}/documents`, { method: "POST", headers: H(cookie), body: JSON.stringify({ kind }) });
  const body = await r.json();
  if (r.status >= 300) throw new Error(`POST documents ${r.status} ${JSON.stringify(body)}`);
  const docId = body.document?.id ?? body.id;
  while (Date.now() - t0 < 240_000) {
    const d = (await (await fetch(base + `/api/boards/${id}/documents/${docId}`, { headers: H(cookie) })).json()).document;
    if (d?.status === "ready") return { d, sec: Math.round((Date.now() - t0) / 1000) };
    if (d?.status === "error" || d?.status === "failed") throw new Error("generation failed: " + JSON.stringify(d).slice(0, 200));
    await sleep(1500);
  }
  throw new Error("generation timed out");
}

await scenario("P13", "turn the board into a doc", async () => {
  const { d, sec } = await generate("doc");
  const md = d.content?.markdown ?? "";
  return { pass: md.length > 300 && /500|beta/i.test(md), sec, detail: `"${d.title}", ${md.length} chars of Markdown` };
});

await scenario("P14", "turn the board into a deck", async () => {
  const { d, sec } = await generate("deck");
  const slides = d.content?.slides ?? [];
  return { pass: slides.length >= 3, sec, detail: `"${d.title}", ${slides.length} slides` };
});

// ---- Web access, chat-only answers ----
const snapshotOf = (els) => new Map(els.map((e) => [e.id, `${e.version}:${e.isDeleted ? 1 : 0}`]));
const sameBoard = (a, b) => a.size === b.size && [...a].every(([id, v]) => b.get(id) === v);

await scenario("W1", "current facts → web search with sources", async () => {
  const id = await board(cookie, "Fares", []);
  const r = await ask(cookie, id, {
    prompt: "What does a one-way Shinkansen ticket from Tokyo to Kyoto cost right now (non-reserved, reserved, Green Car)? Put the fares in a small table.",
  });
  const sources = r.meta.sources ?? [];
  const els = await elements(cookie, id);
  const linked = /\]\(https?:\/\//.test(r.reply);
  const pass = sources.length >= 1 && sources.every((s) => /^https?:\/\//.test(s.url) && s.title) && linked && (r.meta.webLookups ?? 0) >= 1;
  return {
    pass,
    sec: r.sec,
    detail: `${r.meta.webLookups ?? 0} web lookups, ${sources.length} sources (${sources
      .slice(0, 2)
      .map((s) => s.url)
      .join(", ")}), links in reply: ${linked}, ${els.filter(isAi).length} AI elements`,
  };
});

await scenario("C1", "question / options → answer in chat, no board changes", async () => {
  const seed = [...sticky("s1", 0, 0, "Offsite in spring"), ...sticky("s2", 240, 0, "Budget 20k"), ...sticky("s3", 480, 0, "Team of 25")];
  const id = await board(cookie, "Offsite", seed);
  const before = snapshotOf(await elements(cookie, id));
  const r = await ask(cookie, id, { prompt: "Give me three options for where we could hold this offsite, with one pro and one con each." });
  const after = snapshotOf(await elements(cookie, id));
  const unchanged = sameBoard(before, after);
  const changed = (r.meta.created ?? 0) + (r.meta.updated ?? 0) + (r.meta.deleted ?? 0);
  return {
    pass: unchanged && changed === 0 && r.reply.length > 80,
    sec: r.sec,
    detail: `board unchanged: ${unchanged}, element changes: ${changed}, reply ${r.reply.length} chars: "${r.reply.slice(0, 90)}"`,
  };
});

// ---- Shapes, illustrations, cleanup, comments, votes, focus, board limits ----
const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const labelOf = (els, id) => els.find((e) => e.type === "text" && e.containerId === id)?.text ?? "";
const comment = (id, x, y, text, targetId, authorName = "Priya") =>
  el("ellipse", id, x, y, 28, 28, {
    backgroundColor: "#f5d90a",
    customData: { kind: "comment", authorName, text, createdAt: new Date().toISOString(), targetId },
  });
const vote = (id, target, n, userName) =>
  el("ellipse", id, target.x + 10 + n * 26, target.y + 8, 22, 22, {
    backgroundColor: "#f2994a",
    customData: { kind: "vote", targetId: target.id, userId: `u-${userName}`, userName },
  });

await scenario("S1", "new block shapes (person, queue, database) with elbow arrows", async () => {
  const id = await board(cookie, "Architecture", []);
  const r = await ask(cookie, id, {
    prompt:
      "Draw our system architecture as a diagram: customers (as a person), the web app, the API, a job queue, a Postgres database, and file storage shown as a document. Connect them with elbow arrows.",
  });
  const els = await elements(cookie, id);
  const shapes = new Set(els.map((e) => e.customData?.shape).filter(Boolean));
  const fresh = ["person", "queue", "database", "document", "cloud", "pill", "hexagon"].filter((k) => shapes.has(k));
  const arrows = els.filter((e) => e.type === "arrow");
  const bound = arrows.filter((a) => a.startBinding?.elementId && a.endBinding?.elementId && els.some((x) => x.id === a.startBinding.elementId)).length;
  const elbow = arrows.filter((a) => a.elbowed).length;
  return {
    pass: fresh.length >= 3 && bound >= 3 && elbow >= 1,
    sec: r.sec,
    detail: `new shapes: ${fresh.join(", ")}; arrows ${arrows.length} (bound ${bound}, elbow ${elbow})`,
  };
});

await scenario("ST1", "colors and styles, text sizes and lists, links, arrow heads and routing", async () => {
  const id = await board(cookie, "Styles", []);
  const r = await ask(cookie, id, {
    prompt:
      'On this board: a huge title "Q3 plan"; under it a bulleted list with three items (Hire, Ship, Measure); a text line that links to https://example.com labeled "Brief". ' +
      'Then three blocks: "Design" as a blue hollow rectangle, "Build" as a green outline pill, and "Launch" as a filled hexagon in #ff00aa. ' +
      "Connect Design to Build with a dashed arrow that has a circle head at its start, and Build to Launch with a curved arrow.",
  });
  const els = await elements(cookie, id);
  const texts = els.filter((e) => e.type === "text" && !e.containerId);
  const huge = texts.some((t) => t.fontSize >= 44 && /Q3 plan/i.test(t.text));
  const list = texts.some((t) => /•\s*Hire[\s\S]*•\s*Ship[\s\S]*•\s*Measure/.test(t.text));
  const link = els.some((e) => typeof e.link === "string" && e.link.startsWith("https://example.com"));
  const blocks = els.filter((e) => (e.type !== "text" && e.type !== "arrow" && e.type !== "line") || (e.type === "line" && e.customData?.shape));
  const byLabel = (name) =>
    els.find((e) => e.type !== "text" && labelOf(els, e.id).includes(name)) ??
    els.find((e) => e.customData?.label === name || (e.type !== "text" && e.customData?.shape && labelOf(els, e.boundElements?.[0]?.id ?? "") === name));
  const design = byLabel("Design");
  const build = byLabel("Build");
  const launch = els.find((e) => (e.backgroundColor ?? "").toLowerCase() === "#ff00aa" || (e.strokeColor ?? "").toLowerCase() === "#ff00aa");
  const hollow = !!design && design.backgroundColor === "transparent" && design.strokeStyle === "dashed";
  const outline = !!build && build.backgroundColor === "transparent" && build.strokeStyle !== "dashed";
  const arrows = els.filter((e) => e.type === "arrow");
  const dashedCircle = arrows.some((a) => a.strokeStyle === "dashed" && (a.startArrowhead === "circle" || a.startArrowhead === "circle_outline"));
  const curved = arrows.some((a) => (a.points?.length ?? 0) >= 3 && !a.elbowed && a.roundness);
  const checks = { huge, list, link, hollow, outline, hex: !!launch, dashedCircle, curved };
  const passed = Object.values(checks).filter(Boolean).length;
  return {
    pass: passed === Object.keys(checks).length,
    sec: r.sec,
    detail: `${passed}/8 ${JSON.stringify(checks)}; blocks ${blocks.length}, arrows ${arrows.length}`,
  };
});

await scenario("I1", "illustration (marker style), and a polite refusal for people", async () => {
  const id = await board(cookie, "Drawings", []);
  const r1 = await ask(cookie, id, { prompt: "Draw a simple illustration of a mountain with a house next to it." });
  const els1 = await elements(cookie, id);
  const ill = els1.filter((e) => e.customData?.aiKind === "illustration");
  const subjects = [...new Set(ill.map((e) => e.customData.illustration))];
  const r2 = await ask(cookie, id, { prompt: "Now draw a portrait of our CEO's face." });
  const els2 = await elements(cookie, id);
  const ill2 = els2.filter((e) => e.customData?.aiKind === "illustration").length;
  const refused = ill2 === ill.length && /people|faces?|person/i.test(r2.reply);
  return {
    pass: subjects.length >= 1 && refused,
    sec: r1.sec + r2.sec,
    detail: `drew ${subjects.join(" + ")} (${ill.length} strokes, roughness ${ill[0]?.roughness}); refusal: ${refused} — "${r2.reply.slice(0, 100)}"`,
  };
});

await scenario("CL1", "clean up: overlaps resolved, nothing recreated", async () => {
  const seed = [
    ...sticky("o1", 0, 0, "Research"),
    ...sticky("o2", 120, 40, "Interviews"),
    ...sticky("o3", 230, 10, "Synthesis"),
    ...sticky("o4", 15, 260, "Prototype"),
    ...sticky("o5", 250, 300, "Test"),
    ...sticky("o6", 330, 330, "Iterate"),
  ];
  const id = await board(cookie, "Messy", seed);
  const before = await elements(cookie, id);
  const rects = (els) => els.filter((e) => e.customData?.kind === "sticky");
  const pairs = (rs) =>
    rs.flatMap((a, i) =>
      rs
        .slice(i + 1)
        .filter((b) => overlapArea(a, b) > 16)
        .map((b) => [a.id, b.id]),
    );
  const r = await ask(cookie, id, { prompt: "Clean up this board." });
  const after = await elements(cookie, id);
  const sameIds = before.length === after.length && before.every((e) => after.some((a) => a.id === e.id));
  const left = pairs(rects(after));
  return {
    pass: pairs(rects(before)).length >= 3 && left.length === 0 && sameIds,
    sec: r.sec,
    detail: `overlapping pairs ${pairs(rects(before)).length} → ${left.length}; same elements: ${sameIds}; reply: "${r.reply.slice(0, 90)}"`,
  };
});

await scenario("CM1", "address the comments: targets edited in place", async () => {
  const seed = [...sticky("c1", 0, 0, "Launch date: TBD"), ...sticky("c2", 240, 0, "Owner: ?"), ...sticky("c3", 480, 0, "Beta with 50 teams")];
  seed.push(comment("m1", 150, -10, "Set the launch date to March 3", "c1"), comment("m2", 390, -10, "Make Leo the owner", "c2", "Sam"));
  const id = await board(cookie, "Comments", seed);
  const r = await ask(cookie, id, { prompt: "Address the comments on this board." });
  const els = await elements(cookie, id);
  const t1 = labelOf(els, "c1");
  const t2 = labelOf(els, "c2");
  const ok1 = /mar(ch)?\.?\s*3|3\s*mar/i.test(t1);
  const ok2 = /leo/i.test(t2);
  const untouched = labelOf(els, "c3") === "Beta with 50 teams";
  return { pass: ok1 && ok2 && untouched, sec: r.sec, detail: `"${t1}" | "${t2}" | third unchanged: ${untouched}; reply: "${r.reply.slice(0, 80)}"` };
});

await scenario("V1", "votes counted: which idea won", async () => {
  const a = { id: "v1", x: 0, y: 0 },
    b = { id: "v2", x: 240, y: 0 },
    c = { id: "v3", x: 480, y: 0 };
  const seed = [...sticky("v1", 0, 0, "Dark mode"), ...sticky("v2", 240, 0, "Offline sync"), ...sticky("v3", 480, 0, "Templates gallery")];
  seed.push(vote("x1", a, 0, "Ana"), vote("x2", b, 0, "Ana"), vote("x3", b, 1, "Ben"), vote("x4", b, 2, "Cy"), vote("x5", c, 0, "Ben"), vote("x6", c, 1, "Cy"));
  const id = await board(cookie, "Votes", seed);
  const before = snapshotOf(await elements(cookie, id));
  const r = await ask(cookie, id, { prompt: "Which idea won the vote?" });
  const unchanged = sameBoard(before, snapshotOf(await elements(cookie, id)));
  const pass = /offline sync/i.test(r.reply) && /\b3\b|three/i.test(r.reply) && unchanged;
  return { pass, sec: r.sec, detail: `board unchanged: ${unchanged}; reply: "${r.reply.slice(0, 120)}"` };
});

await scenario("F1", '"this" means the selection', async () => {
  const seed = [...sticky("f1", 0, 0, "Plan"), ...sticky("f2", 240, 0, "Build"), ...sticky("f3", 480, 0, "Launch")];
  const id = await board(cookie, "Focus", seed);
  const before = await elements(cookie, id);
  const r = await ask(cookie, id, { prompt: 'Make this green and change it to say "Ship it".', focusElementIds: ["f2"] });
  const els = await elements(cookie, id);
  const f2 = els.find((e) => e.id === "f2");
  const others = ["f1", "f3"].every(
    (k) => els.find((e) => e.id === k).version === before.find((e) => e.id === k).version && labelOf(els, k) === labelOf(before, k),
  );
  const noHandles = !/\b[esakbw]\d{1,4}\b/.test(r.reply);
  const pass = /ship it/i.test(labelOf(els, "f2")) && f2.backgroundColor.toLowerCase() === "#5fd35f" && others && noHandles;
  return {
    pass,
    sec: r.sec,
    detail: `selected: "${labelOf(els, "f2")}" ${f2.backgroundColor}; others untouched: ${others}; no internal handles in the reply: ${noHandles} — "${r.reply.slice(0, 90)}"`,
  };
});

await scenario("LK1", "locked items are left alone (clean up and recolor)", async () => {
  const lockedSticky = sticky("k1", 0, 0, "Budget approved");
  lockedSticky[0].locked = true;
  lockedSticky[1].locked = true;
  const seed = [...lockedSticky, ...sticky("k2", 60, 40, "Hire designer"), ...sticky("k3", 120, 80, "Pick venue")];
  const id = await board(cookie, "Locks", seed);
  const before = await elements(cookie, id);
  const r = await ask(cookie, id, { prompt: "Clean up the layout so nothing overlaps, then make every sticky green." });
  const els = await elements(cookie, id);
  const k1b = before.find((e) => e.id === "k1");
  const k1 = els.find((e) => e.id === "k1");
  const lockedSame =
    k1.x === k1b.x && k1.y === k1b.y && k1.backgroundColor === k1b.backgroundColor && k1.version === k1b.version && labelOf(els, "k1") === "Budget approved";
  const othersChanged = ["k2", "k3"].some((k) => {
    const a = before.find((e) => e.id === k);
    const b = els.find((e) => e.id === k);
    return b.x !== a.x || b.y !== a.y || b.backgroundColor !== a.backgroundColor;
  });
  return {
    pass: lockedSame && othersChanged,
    sec: r.sec,
    detail: `locked sticky untouched: ${lockedSame}; others changed: ${othersChanged}; reply: "${r.reply.slice(0, 140)}"`,
  };
});

await scenario("L1", "800-element board limit (AI and people)", async () => {
  const seed = [];
  for (let i = 0; i < 398; i++) seed.push(...sticky(`l${i}`, (i % 20) * 200, Math.floor(i / 20) * 200, `Idea ${i + 1}`));
  const id = await board(cookie, "Full board", seed);
  const n0 = (await elements(cookie, id)).length;
  const r = await ask(cookie, id, { prompt: "Add 10 more ideas for a launch party as sticky notes." });
  const n1 = (await elements(cookie, id)).length;
  // A person adding an element past the limit gets a polite error frame.
  const { default: WebSocket } = await import("ws");
  const frame = await new Promise((resolve) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/api/ws", { headers: { cookie, origin: base } });
    const timer = setTimeout(() => {
      ws.close();
      resolve(null);
    }, 8000);
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.t === "init")
        ws.send(
          JSON.stringify({
            t: "elements",
            elements: [
              ...sticky("extra1", 5000, 5000, "One more"),
              ...sticky("extra2", 5300, 5000, "And another"),
              ...sticky("extra3", 5600, 5000, "Past the limit"),
            ],
          }),
        );
      if (m.t === "error" && m.code === "board_full") {
        clearTimeout(timer);
        ws.close();
        resolve(m);
      }
    });
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", boardId: id })));
  });
  const n2 = (await elements(cookie, id)).length;
  const said = /full|limit/i.test(r.reply);
  const pass = n1 <= 800 && n2 <= 800 && said && r.meta.boardFull === true && !!frame;
  return {
    pass,
    sec: r.sec,
    detail: `elements ${n0} → ${n1} after the AI → ${n2} after a person (3 stickies sent); reply says full: ${said}, meta.boardFull: ${r.meta.boardFull}; error frame: ${frame ? frame.message.slice(0, 60) : "none"}`,
  };
});

const passed = results.filter((r) => r.pass).length;
console.log(
  JSON.stringify({ passed, total: results.length, results: results.map(({ item, name, pass, detail, sec }) => ({ item, name, pass, sec, detail })) }),
);
process.exit(passed === results.length ? 0 : 1);
