// Board side of live embeds: renders the sealed frame for an `embeddable` element whose link points at
// embed.monet.local and bridges its shared state.
//
//   frame -> host  {monet:'loader-ready'}            (window message, once per frame)
//   host -> frame  {monet:'load', doc} + a MessagePort (window message, answer to that one hello)
//   then over the port only:
//   frame -> host  {monet:'ready'} | {monet:'setState', patch}
//   host -> frame  {monet:'init'|'state', state, info}
//
// The frame's origin is opaque (sandboxed), so window messages can't name a target origin. Everything after the
// hello goes over the port, which stays with the runner's document: if an embed navigates its frame elsewhere, the
// new page never gets the port, state, or who's viewing. A second hello from the same frame element means it
// reloaded or was navigated: it gets nothing, and the frame is replaced by a fresh runner (a few times at most).
//
// setState patches are deep-merged into element.customData.state with newElementWith, so they reach everyone
// live through the normal element sync and persist with the board. If two people write at the same moment, one
// write loses (same version, the other nonce wins); the loser's client re-applies it (see reconcilePending).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawEmbeddableElement, NonDeleted } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { buildEmbedDocument, LIVE_EMBED_HOST, type LiveEmbedData } from './templates';

// Versioned so a cached copy of an older runner is never used. Bump it whenever the runner's messages change.
export const FRAME_URL = `${import.meta.env.BASE_URL}embed-frame.html?v=3`;
/** Largest shared state an embed may keep (JSON characters). */
export const MAX_STATE_CHARS = 32_000;

// ---------- host context (set by BoardInputs) ----------

export interface LiveEmbedHost {
  api: ExcalidrawImperativeAPI | null;
  me: { id: string; name: string; color: string } | null;
  canEdit: boolean;
  theme: 'dark' | 'light';
}

let host: LiveEmbedHost = { api: null, me: null, canEdit: false, theme: 'dark' };
const hostListeners = new Set<() => void>();
export function setLiveEmbedHost(next: LiveEmbedHost) {
  if (next.api === host.api && next.me?.id === host.me?.id && next.me?.name === host.me?.name && next.canEdit === host.canEdit && next.theme === host.theme)
    return;
  host = next;
  hostListeners.forEach((l) => l());
}
function useHost() {
  return useSyncExternalStore(
    (l) => {
      hostListeners.add(l);
      return () => hostListeners.delete(l);
    },
    () => host,
  );
}

// ---------- state merge ----------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export function mergeState(a: Json, b: Json): Json {
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === null) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = mergeState(out[k] as Json, v);
    else out[k] = v;
  }
  return out;
}

/** Combines two patches into one, keeping `null` (a deletion) so it still applies. */
export function mergePatch(a: Json, b: Json): Json {
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (isObj(v) && isObj(out[k])) out[k] = mergePatch(out[k] as Json, v);
    else out[k] = v;
  }
  return out;
}

function contains(state: Json, patch: Json): boolean {
  return Object.entries(patch).every(([k, v]) => {
    if (v === null) return !(k in state);
    if (isObj(v)) return isObj(state[k]) && contains(state[k] as Json, v);
    return JSON.stringify(state[k]) === JSON.stringify(v);
  });
}

export function isLiveEmbed(el: { type: string; link?: string | null; customData?: unknown }): boolean {
  if (el.type !== 'embeddable') return false;
  if ((el.customData as { kind?: string } | undefined)?.kind === 'live-embed') return true;
  try {
    return !!el.link && new URL(el.link).hostname === LIVE_EMBED_HOST;
  } catch {
    return false;
  }
}

/** Kind from the element's link (https://embed.monet.local/<kind>) when customData doesn't say. */
function dataOf(el: NonDeleted<ExcalidrawEmbeddableElement>): LiveEmbedData {
  const cd = (el.customData ?? {}) as Partial<LiveEmbedData>;
  let kind = cd.embedKind;
  if (!kind && el.link) {
    try {
      kind = new URL(el.link).pathname.replace(/^\//, '') as LiveEmbedData['embedKind'];
    } catch {
      /* fall through */
    }
  }
  return {
    kind: 'live-embed',
    embedKind: kind ?? 'custom',
    title: typeof cd.title === 'string' ? cd.title : undefined,
    html: typeof cd.html === 'string' ? cd.html : undefined,
    config: isObj(cd.config) ? cd.config : {},
    state: isObj(cd.state) ? cd.state : {},
  };
}

// Recent local patches per element, with the element version each write produced. A patch is re-applied only if
// it lost a simultaneous write: a remote state at the same or a lower version that doesn't contain it. A higher
// version was written by someone who had already seen ours (e.g. they paused the timer), so theirs wins.
const pending = new Map<string, { patch: Json; at: number; version: number }[]>();
const PENDING_MS = 15_000;

/** Writes merged state onto the element; returns the element's new version (null if refused). */
function writeState(api: ExcalidrawImperativeAPI, id: string, patch: Json): number | null {
  const all = api.getSceneElementsIncludingDeleted();
  const el = all.find((e) => e.id === id);
  if (!el || el.isDeleted) return null;
  const cd = (el.customData ?? {}) as Json;
  const next = mergeState(isObj(cd.state) ? (cd.state as Json) : {}, patch);
  if (JSON.stringify(next).length > MAX_STATE_CHARS) return null;
  const updated = newElementWith(el, { customData: { ...cd, state: next } });
  api.updateScene({
    elements: all.map((e) => (e.id === id ? updated : e)),
    // Shared embed state isn't part of anyone's undo history.
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  return updated.version;
}

function applyPatch(api: ExcalidrawImperativeAPI, id: string, patch: Json) {
  const el = api.getSceneElementsIncludingDeleted().find((e) => e.id === id);
  if (!el) return;
  // Recorded before writing, because the write can re-render (and reconcile) synchronously.
  const entry = { patch, at: Date.now(), version: el.version + 1 };
  const list = pending.get(id) ?? [];
  list.push(entry);
  pending.set(id, list.slice(-20));
  const version = writeState(api, id, patch);
  if (version === null)
    pending.set(
      id,
      (pending.get(id) ?? []).filter((p) => p !== entry),
    );
  else entry.version = version;
}

/** After the element changes, re-apply our recent patches that lost a simultaneous write. */
function reconcilePending(api: ExcalidrawImperativeAPI, id: string, state: Json, version: number) {
  const list = pending.get(id);
  if (!list?.length) return;
  const now = Date.now();
  const missing: Json[] = [];
  const keep = list.filter((p) => {
    if (now - p.at > PENDING_MS) return false;
    if (version > p.version) return false;
    if (contains(state, p.patch)) return true;
    missing.push(p.patch);
    return true;
  });
  pending.set(id, keep);
  if (missing.length) {
    const merged = missing.reduce((acc, p) => mergePatch(acc, p), {} as Json);
    setTimeout(() => applyPatch(api, id, merged), 80 + Math.random() * 120);
  }
}

// ---------- the frame ----------

export function LiveEmbedFrame({ element }: { element: NonDeleted<ExcalidrawEmbeddableElement> }) {
  const h = useHost();
  const frame = useRef<HTMLIFrameElement>(null);
  const data = dataOf(element);
  const configKey = JSON.stringify(data.config);
  const doc = useMemo(() => buildEmbedDocument(data), [data.embedKind, data.html, data.title, configKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const stateKey = JSON.stringify(data.state);
  const info = useMemo(
    () => ({ me: h.me, config: data.config, readOnly: !h.canEdit || !h.me, theme: h.theme, title: data.title ?? '' }),
    [h.me, h.canEdit, h.theme, configKey, data.title], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const latest = useRef({ doc, state: data.state ?? {}, info, id: element.id });
  latest.current = { doc, state: data.state ?? {}, info, id: element.id };

  /** The channel to the runner in the current frame element (null before its hello, or after it navigated away). */
  const port = useRef<MessagePort | null>(null);
  /** The frame element whose runner already got its document and port. */
  const served = useRef<HTMLIFrameElement | null>(null);
  const [generation, setGeneration] = useState(0);
  const remounts = useRef<number[]>([]);
  const post = (msg: unknown) => port.current?.postMessage(msg);

  useEffect(() => {
    let queued: Json | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (queued && host.api && host.canEdit) applyPatch(host.api, latest.current.id, queued);
      queued = null;
    };
    const closePort = () => {
      port.current?.close();
      port.current = null;
    };
    const onPortMessage = (e: MessageEvent) => {
      const d = e.data as { monet?: string; patch?: unknown } | null;
      if (!d || typeof d.monet !== 'string') return;
      if (d.monet === 'ready') post({ monet: 'init', state: latest.current.state, info: latest.current.info });
      else if (d.monet === 'setState' && isObj(d.patch) && host.canEdit) {
        // Coalesce bursts (typing, rapid clicks) into one element update per 120 ms.
        queued = mergePatch(queued ?? {}, d.patch);
        if (!timer) timer = setTimeout(flush, 120);
      }
    };
    const onMessage = (e: MessageEvent) => {
      const el = frame.current;
      if (!el || e.source !== el.contentWindow) return;
      const d = e.data as { monet?: string } | null;
      if (!d || d.monet !== 'loader-ready') return;
      closePort();
      // The runner says hello once per frame element. Another hello from the same element means the frame reloaded
      // or the embed navigated it: whatever runs there now gets nothing. Swap in a fresh runner (a new element, whose
      // first hello can only come from the runner), at most 3 times in 30 s so an embed that keeps leaving just stops.
      if (served.current === el) {
        const now = Date.now();
        remounts.current = remounts.current.filter((t) => now - t < 30_000);
        if (remounts.current.length < 3) {
          remounts.current.push(now);
          setGeneration((g) => g + 1);
        }
        return;
      }
      served.current = el;
      const channel = new MessageChannel();
      channel.port1.onmessage = onPortMessage;
      port.current = channel.port1;
      el.contentWindow?.postMessage({ monet: 'load', doc: latest.current.doc }, '*', [channel.port2]);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      closePort();
      if (timer) {
        clearTimeout(timer);
        flush();
      }
    };
  }, []);

  // Excalidraw tracks the interactive ("active") embed by element object. Every shared-state change replaces the
  // element, which would drop interactivity mid-use (after a vote, or when someone else starts the timer). Point it
  // at the current element again.
  useLayoutEffect(() => {
    const api = host.api;
    if (!api) return;
    const active = api.getAppState().activeEmbeddable;
    if (active && active.element.id === element.id && active.element !== element) {
      api.updateScene({ appState: { activeEmbeddable: { element, state: active.state } } as never, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }, [element]);

  // Push state (local or remote) and identity/theme changes into the frame.
  useEffect(() => {
    post({ monet: 'state', state: latest.current.state, info: latest.current.info });
    if (host.api && host.canEdit) reconcilePending(host.api, element.id, latest.current.state as Json, element.version);
  }, [stateKey, info, element.id, element.version]);

  return (
    <iframe
      // A new document (kind/html/config changed) reloads the sealed frame.
      key={generation + ':' + doc.length + ':' + hash(doc)}
      ref={frame}
      className="excalidraw__embeddable"
      src={FRAME_URL}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={data.title || `Live ${data.embedKind}`}
      data-testid={`live-embed-${data.embedKind}`}
      data-element-id={element.id}
      style={{ width: '100%', height: '100%', border: 0, display: 'block', background: 'var(--monet-surface, #1f1f1f)' }}
    />
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
