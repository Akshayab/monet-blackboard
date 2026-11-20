// Documents for live embeds. Each embed runs in the sealed frame (public/embed-frame.html) and talks to the board
// only through `window.monet`, injected by BRIDGE:
//   monet.getState()       -> the shared state saved on the board element
//   monet.setState(patch)  -> deep-merges `patch` (null deletes a key), saves it for everyone
//   monet.onState(cb)      -> cb(state, info) now and whenever anyone changes it
//   monet.me / config / readOnly / theme / title
// Templates use CSS variables switched by html[data-theme] so they look right on dark and light boards.

export type LiveEmbedKind = 'poll' | 'timer' | 'calculator' | 'prototype' | 'custom';
export const LIVE_EMBED_KINDS: LiveEmbedKind[] = ['poll', 'timer', 'calculator', 'prototype', 'custom'];
export { LIVE_EMBED_HOST } from '@monet/board-protocol';
export const MAX_EMBED_HTML = 16_000;

export interface LiveEmbedData {
  kind: 'live-embed';
  embedKind: LiveEmbedKind;
  title?: string;
  html?: string;
  config?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export const EMBED_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

const BRIDGE = `(function(){
  var state = {}, info = { me: null, config: {}, readOnly: true, theme: 'dark', title: '' }, listeners = [], ready = false;
  // The board talks to the embed only over the private port the runner received with this document.
  var port = window.__monetPort || null;
  try { delete window.__monetPort; } catch (err) {}
  function send(m) { if (port) port.postMessage(m); }
  function merge(a, b) {
    var out = {};
    for (var k in a) out[k] = a[k];
    for (var key in b) {
      var v = b[key];
      if (v === null) delete out[key];
      else if (v && typeof v === 'object' && !Array.isArray(v) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) out[key] = merge(out[key], v);
      else out[key] = v;
    }
    return out;
  }
  function emit() {
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](state, info); } catch (err) { console.error(err); } }
  }
  var api = {
    getState: function () { return state; },
    setState: function (patch) {
      if (info.readOnly || !patch || typeof patch !== 'object') return;
      state = merge(state, patch);
      send({ monet: 'setState', patch: patch });
      emit();
    },
    onState: function (cb) { listeners.push(cb); if (ready) { try { cb(state, info); } catch (err) { console.error(err); } } },
    me: null, config: {}, readOnly: true, theme: 'dark', title: ''
  };
  window.monet = api;
  if (port) port.onmessage = function (e) {
    var d = e.data;
    if (!d || (d.monet !== 'init' && d.monet !== 'state')) return;
    if (d.state && typeof d.state === 'object') state = d.state;
    if (d.info) {
      for (var k in d.info) info[k] = d.info[k];
      api.me = info.me; api.config = info.config || {}; api.readOnly = !!info.readOnly; api.theme = info.theme; api.title = info.title || '';
      document.documentElement.setAttribute('data-theme', info.theme === 'light' ? 'light' : 'dark');
      document.documentElement.toggleAttribute('data-readonly', !!info.readOnly);
    }
    ready = true;
    emit();
  };
  document.addEventListener('DOMContentLoaded', function () { send({ monet: 'ready' }); });
})();`;

const BASE_CSS = `
:root{--bg:#1f1f1f;--panel:#262626;--fg:#f5f5f5;--muted:#a3a3a3;--line:#333333;--accent:#4d8ff7;--on-accent:#0b1220;--accent-soft:#1b2540;--danger:#e8579f;--btn:#2a2a2a;--btn-hover:#333333}
html[data-theme=light]{--bg:#ffffff;--panel:#f5f5f5;--fg:#1a1a1a;--muted:#5f5f5f;--line:#e5e5e5;--accent:#245fcf;--on-accent:#ffffff;--accent-soft:#e6eefe;--danger:#c2185b;--btn:#f0f0f0;--btn-hover:#e5e5e5}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:14px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;cursor:pointer}
html[data-readonly] button{cursor:default}
`;

function page(body: string, css = ''): string {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${EMBED_CSP}"><script>${BRIDGE}</script><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;
}

const POLL = page(
  `<main><h1 id="q"></h1><div id="opts" role="list"></div><p class="foot" id="foot"></p></main>
<script>
var q = document.getElementById('q'), opts = document.getElementById('opts'), foot = document.getElementById('foot');
function render(state, info) {
  var cfg = info.config || {}, options = Array.isArray(cfg.options) && cfg.options.length ? cfg.options : ['Yes', 'No'];
  var votes = state.votes || {}, counts = options.map(function () { return 0; }), total = 0;
  for (var id in votes) { var v = votes[id]; if (typeof v === 'number' && v >= 0 && v < options.length) { counts[v]++; total++; } }
  var mine = info.me ? votes[info.me.id] : undefined;
  q.textContent = cfg.question || info.title || 'Poll';
  opts.innerHTML = '';
  options.forEach(function (label, i) {
    var b = document.createElement('button');
    b.className = 'opt' + (mine === i ? ' mine' : '');
    b.setAttribute('data-testid', 'poll-option-' + i);
    b.setAttribute('aria-pressed', mine === i ? 'true' : 'false');
    var pct = total ? Math.round((counts[i] / total) * 100) : 0;
    b.innerHTML = '<span class="bar" style="width:' + pct + '%"></span><span class="lbl"></span><span class="n" data-testid="poll-count-' + i + '">' + counts[i] + '</span>';
    b.querySelector('.lbl').textContent = String(label);
    b.onclick = function () {
      if (monet.readOnly || !info.me) return;
      var p = { votes: {}, names: {} };
      p.votes[info.me.id] = mine === i ? null : i;
      p.names[info.me.id] = mine === i ? null : info.me.name;
      monet.setState(p);
    };
    opts.appendChild(b);
  });
  var names = state.names || {}, who = Object.keys(votes).map(function (id) { return names[id]; }).filter(Boolean);
  foot.textContent = total + (total === 1 ? ' vote' : ' votes') + (who.length ? ' · ' + who.slice(0, 4).join(', ') + (who.length > 4 ? ' +' + (who.length - 4) : '') : '') +
    (monet.readOnly ? ' · view only' : mine === undefined ? ' · pick one' : ' · click again to take back');
}
monet.onState(render);
</script>`,
  `main{padding:14px 16px;height:100%;overflow:auto}
h1{font-size:15px;font-weight:650;margin:0 0 10px}
.opt{position:relative;display:flex;align-items:center;gap:8px;width:100%;margin:6px 0;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);overflow:hidden;text-align:left}
.opt:hover{border-color:var(--muted)}
.opt.mine{border-color:var(--accent)}
.opt .bar{position:absolute;left:0;top:0;bottom:0;background:var(--accent-soft);transition:width .35s ease}
.opt .lbl{position:relative;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.opt .n{position:relative;font-variant-numeric:tabular-nums;color:var(--muted);font-weight:600}
.opt.mine .n{color:var(--accent)}
.foot{margin:10px 0 0;color:var(--muted);font-size:12px}`,
);

const TIMER = page(
  `<main><div class="label" id="label"></div><div class="time" id="time" data-testid="timer-display">05:00</div>
<div class="row"><button id="minus" title="1 minute less">−1m</button><button id="go" class="primary" data-testid="timer-start">Start</button><button id="reset" data-testid="timer-reset">Reset</button><button id="plus" title="1 minute more">+1m</button></div></main>
<script>
var S = {}, I = { config: {} };
var el = { label: document.getElementById('label'), time: document.getElementById('time'), go: document.getElementById('go'), reset: document.getElementById('reset'), minus: document.getElementById('minus'), plus: document.getElementById('plus') };
function duration() {
  var d = S.duration, c = I.config || {};
  if (typeof d !== 'number') d = Number(c.seconds) > 0 ? Number(c.seconds) * 1000 : Number(c.minutes) > 0 ? Number(c.minutes) * 60000 : 300000;
  return Math.max(1000, d);
}
function elapsed() { var e = Number(S.elapsed) || 0; if (typeof S.startedAt === 'number') e += Date.now() - S.startedAt; return e; }
function fmt(ms) { var s = Math.ceil(Math.max(0, ms) / 1000), m = Math.floor(s / 60); s = s % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
function tick() {
  var left = duration() - elapsed(), running = typeof S.startedAt === 'number';
  el.time.textContent = left <= 0 ? '00:00' : fmt(left);
  document.body.classList.toggle('done', left <= 0);
  document.body.classList.toggle('running', running && left > 0);
  el.go.textContent = running && left > 0 ? 'Pause' : left <= 0 ? 'Done' : elapsed() > 0 ? 'Resume' : 'Start';
  el.minus.disabled = el.plus.disabled = running || monet.readOnly;
  el.go.disabled = el.reset.disabled = monet.readOnly;
}
monet.onState(function (state, info) { S = state; I = info; el.label.textContent = (info.config && info.config.label) || info.title || 'Timer'; tick(); });
setInterval(tick, 250);
el.go.onclick = function () {
  var running = typeof S.startedAt === 'number';
  if (duration() - elapsed() <= 0) return;
  if (running) monet.setState({ startedAt: null, elapsed: elapsed() });
  else monet.setState({ startedAt: Date.now() });
};
el.reset.onclick = function () { monet.setState({ startedAt: null, elapsed: 0 }); };
el.minus.onclick = function () { monet.setState({ duration: Math.max(60000, duration() - 60000) }); };
el.plus.onclick = function () { monet.setState({ duration: Math.min(5999000, duration() + 60000) }); };
</script>`,
  `main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px}
.label{color:var(--muted);font-size:13px;font-weight:600;letter-spacing:.02em;text-align:center}
.time{font-size:52px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:.02em;line-height:1}
.running .time{color:var(--accent)}
.done .time{color:var(--danger);animation:pulse 1s ease-in-out infinite}
@keyframes pulse{50%{opacity:.45}}
.row{display:flex;gap:6px;margin-top:6px}
.row button{border:1px solid var(--line);background:var(--btn);border-radius:8px;padding:6px 10px;font-size:13px}
.row button:hover:not(:disabled){background:var(--btn-hover)}
.row button:disabled{opacity:.45}
.row .primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);min-width:72px}`,
);

const CALCULATOR = page(
  `<main><div class="hist" id="hist"></div><div class="disp" id="disp" data-testid="calc-display">0</div><div class="keys" id="keys"></div></main>
<script>
var KEYS = ['C', '⌫', '%', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '±', '0', '.', '='];
var S = {};
function tokens(s) { return s.match(/\\d*\\.?\\d+|[+\\-×÷%()]/g) || []; }
function evaluate(expr) {
  var out = [], ops = [], prec = { '+': 1, '-': 1, '×': 2, '÷': 2 }, t = tokens(expr.replace(/−/g, '-')), prev = null;
  function apply() { var o = ops.pop(), b = out.pop(), a = out.pop(); if (a === undefined || b === undefined) throw 0; out.push(o === '+' ? a + b : o === '-' ? a - b : o === '×' ? a * b : a / b); }
  for (var i = 0; i < t.length; i++) {
    var x = t[i];
    if (x === '-' && (prev === null || prec[prev])) { t[i + 1] = '-' + t[i + 1]; prev = x; continue; }
    if (x === '%') { out.push(out.pop() / 100); prev = 'n'; continue; }
    if (prec[x]) { while (ops.length && prec[ops[ops.length - 1]] >= prec[x]) apply(); ops.push(x); prev = x; continue; }
    out.push(parseFloat(x)); prev = 'n';
  }
  while (ops.length) apply();
  if (out.length !== 1 || !isFinite(out[0])) throw 0;
  return Math.round(out[0] * 1e10) / 1e10;
}
function render(state) {
  S = state;
  document.getElementById('disp').textContent = state.expr || '0';
  var h = Array.isArray(state.history) ? state.history : [];
  document.getElementById('hist').textContent = h.slice(-3).join('   ');
}
var keys = document.getElementById('keys');
KEYS.forEach(function (k) {
  var b = document.createElement('button');
  b.textContent = k;
  b.className = /[÷×−+=]/.test(k) ? 'op' : /[C⌫%±]/.test(k) ? 'fn' : '';
  b.onclick = function () { press(k); };
  keys.appendChild(b);
});
function press(k) {
  var e = S.expr || '';
  if (k === 'C') return monet.setState({ expr: '' });
  if (k === '⌫') return monet.setState({ expr: e.slice(0, -1) });
  if (k === '±') { var m = e.match(/(-?)(\\d*\\.?\\d+)$/); if (!m) return; return monet.setState({ expr: e.slice(0, e.length - m[0].length) + (m[1] ? '' : '-') + m[2] }); }
  if (k === '=') {
    try { var r = evaluate(e); var h = (Array.isArray(S.history) ? S.history : []).concat([e + ' = ' + r]).slice(-10); monet.setState({ expr: String(r), history: h }); }
    catch (err) { monet.setState({ expr: 'Error' }); }
    return;
  }
  if (e === 'Error') e = '';
  if (e.length >= 40) return;
  monet.setState({ expr: e + k });
}
monet.onState(render);
</script>`,
  `main{height:100%;display:flex;flex-direction:column;padding:12px;gap:6px}
.hist{min-height:16px;color:var(--muted);font-size:11px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.disp{font-size:30px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums;padding:4px 6px 8px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.keys{flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.keys button{border:1px solid var(--line);background:var(--btn);border-radius:8px;font-size:17px}
.keys button:hover{background:var(--btn-hover)}
.keys .op{background:var(--accent-soft);color:var(--accent);font-weight:700}
.keys .fn{color:var(--muted)}`,
);

const PROTOTYPE_CSS = `body{padding:0}`;

/** A user- or AI-written page (prototype/custom), wrapped with the sealed policy and the bridge. */
function userPage(html: string): string {
  if (html.length > MAX_EMBED_HTML) {
    return page(`<p style="padding:16px;color:var(--muted)">This embed is too large to run (over ${MAX_EMBED_HTML.toLocaleString('en-US')} characters).</p>`);
  }
  return page(html, PROTOTYPE_CSS);
}

const EMPTY_PROTOTYPE = page(`<p style="padding:16px;color:var(--muted)">No prototype HTML yet.</p>`);

export function buildEmbedDocument(data: LiveEmbedData): string {
  switch (data.embedKind) {
    case 'poll':
      return POLL;
    case 'timer':
      return TIMER;
    case 'calculator':
      return CALCULATOR;
    case 'prototype':
    case 'custom':
    default:
      return data.html ? userPage(data.html) : EMPTY_PROTOTYPE;
  }
}

/** Default size on the board for a new embed of each kind. */
export function defaultEmbedSize(kind: LiveEmbedKind, config?: Record<string, unknown>) {
  switch (kind) {
    case 'poll': {
      const n = Array.isArray(config?.options) ? (config!.options as unknown[]).length : 2;
      return { width: 360, height: Math.min(560, 104 + n * 46) };
    }
    case 'timer':
      return { width: 300, height: 200 };
    case 'calculator':
      return { width: 280, height: 380 };
    default:
      return { width: 480, height: 360 };
  }
}

export const KIND_LABELS: Record<LiveEmbedKind, string> = {
  poll: 'Poll',
  timer: 'Timer',
  calculator: 'Calculator',
  prototype: 'Prototype',
  custom: 'Custom',
};
