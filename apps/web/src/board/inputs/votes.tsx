// Face-sticker votes: select items and press "Vote" (or U) to put your face sticker (your initial in your presence
// color) on each one; press again to take it back. One vote per person per item.
//
// A vote is an ordinary, locked ellipse with customData { kind: 'vote', targetId, userId, userName, slot } plus a
// bound label (customData.kind = 'vote-label'), so it syncs live, persists, and the AI can count votes per item.
// Stickers sit along the item's top edge. When someone moves or deletes a voted item, their client moves or
// removes the stickers (only for changes made locally, so collaborators never fight over positions).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaptureUpdateAction, getCommonBounds, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ThumbsUp } from 'lucide-react';
import { DARK_PALETTE, FONT, makeShape, type SceneElement } from '@monet/board-protocol';
import type { CollabApi } from '../use-collab';
import { isInOverlay, isWritable, Overlay } from './overlay';
import { insertElements, sceneToClient } from './scene';
import type { SceneState } from './use-scene-state';
import { VOTE_SHORTCUT } from '@/components/shortcuts/registry';

const SIZE = 26;
const STEP = 20;

export interface Voter {
  id: string;
  name: string;
  color: string;
}

type Cd = { kind?: string; targetId?: string; userId?: string; userName?: string; slot?: number; voteId?: string };
const cdOf = (e: ExcalidrawElement) => (e.customData ?? {}) as Cd;
export const isVote = (e: ExcalidrawElement) => e.type === 'ellipse' && cdOf(e).kind === 'vote';
const isVoteLabel = (e: ExcalidrawElement) => e.type === 'text' && cdOf(e).kind === 'vote-label';
const NOT_VOTABLE = new Set(['vote', 'vote-label', 'comment']);

/** Things people can vote on: any top-level item except votes and comment pins. */
export function isVotable(e: ExcalidrawElement) {
  if (e.isDeleted || e.locked) return false;
  if (e.type === 'text' && 'containerId' in e && e.containerId) return false;
  return !NOT_VOTABLE.has(cdOf(e).kind ?? '');
}

function textOn(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#1a1a1a';
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1a1a1a' : '#ffffff';
}

/** Top-left of a vote sticker in slot `slot` on `target` (right to left along the top edge, wrapping). */
function slotPosition(target: ExcalidrawElement, slot: number) {
  const [minX, minY, maxX] = getCommonBounds([target]);
  const perRow = Math.max(1, Math.floor((maxX - minX - 8) / STEP));
  const row = Math.floor(slot / perRow);
  const col = slot % perRow;
  return { x: maxX - 6 - SIZE - col * STEP, y: minY - SIZE / 2 + row * (SIZE - 4) };
}

function votesOn(all: readonly ExcalidrawElement[], targetId: string) {
  return all.filter((e) => !e.isDeleted && isVote(e) && cdOf(e).targetId === targetId);
}

function labelsFor(all: readonly ExcalidrawElement[], voteIds: Set<string>) {
  return all.filter((e) => !e.isDeleted && isVoteLabel(e) && voteIds.has(cdOf(e).voteId ?? ''));
}

/** Toggles my vote on each target: removes them if I've voted on all, otherwise adds the missing ones. */
export function toggleVotes(api: ExcalidrawImperativeAPI, targets: readonly ExcalidrawElement[], me: Voter) {
  const items = targets.filter(isVotable);
  if (!items.length) return;
  const all = api.getSceneElementsIncludingDeleted();
  const mine = (t: ExcalidrawElement) => votesOn(all, t.id).find((v) => cdOf(v).userId === me.id);
  if (items.every((t) => mine(t))) {
    const ids = new Set(items.map((t) => mine(t)!.id));
    const kill = new Set([...ids, ...labelsFor(all, ids).map((l) => l.id)]);
    api.updateScene({
      elements: all.map((e) => (kill.has(e.id) ? newElementWith(e, { isDeleted: true }) : e)),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return;
  }
  const created: SceneElement[] = [];
  for (const t of items) {
    if (mine(t)) continue;
    const used = new Set(votesOn(all, t.id).map((v) => cdOf(v).slot ?? 0));
    let slot = 0;
    while (used.has(slot)) slot++;
    const { x, y } = slotPosition(t, slot);
    const [circle, label] = makeShape({
      shape: 'ellipse',
      x,
      y,
      width: SIZE,
      height: SIZE,
      backgroundColor: me.color,
      strokeColor: DARK_PALETTE.CANVAS_BG,
      strokeWidth: 2,
      roughness: 0,
      locked: true,
      label: (me.name.trim()[0] ?? '?').toUpperCase(),
      fontSize: 13,
      fontFamily: FONT.normal,
      customData: { kind: 'vote', targetId: t.id, userId: me.id, userName: me.name, slot },
    });
    if (label) {
      label.strokeColor = textOn(me.color);
      label.locked = true;
      label.customData = { kind: 'vote-label', targetId: t.id, voteId: circle!.id };
      created.push(circle!, label);
    } else created.push(circle!);
  }
  if (created.length) insertElements(api, created, { select: false });
}

/**
 * Keeps vote stickers on their item: when an item with votes is moved, resized or deleted *by this person*, move
 * (or remove) its stickers. Remote changes are left to the person who made them.
 */
function useVoteFollower(api: ExcalidrawImperativeAPI | null, collab: CollabApi, canEdit: boolean) {
  const remote = useRef(new Map<string, number>());
  useEffect(
    () =>
      collab.onRemoteElements(({ elements }) => {
        for (const el of elements) remote.current.set(el.id, el.version);
      }),
    [collab.onRemoteElements], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    if (!api || !canEdit) return;
    const last = new Map<string, string>();
    let raf = 0;
    const check = () => {
      raf = 0;
      const app = api.getAppState();
      // Wait until a drag or resize ends; the stickers then jump to the new place in one update.
      if (app.selectedElementsAreBeingDragged || app.isResizing || app.isRotating || app.cursorButton === 'down') return;
      const all = api.getSceneElementsIncludingDeleted();
      const byId = new Map(all.map((e) => [e.id, e]));
      const groups = new Map<string, ExcalidrawElement[]>();
      for (const v of all) {
        if (v.isDeleted || !isVote(v)) continue;
        const tid = cdOf(v).targetId;
        if (!tid) continue;
        groups.set(tid, [...(groups.get(tid) ?? []), v]);
      }
      const updates = new Map<string, ExcalidrawElement>();
      for (const [tid, votes] of groups) {
        const t = byId.get(tid);
        if (!t) continue;
        const key = t.isDeleted ? 'deleted' : `${t.x}:${t.y}:${t.width}:${t.height}:${t.angle}`;
        const prev = last.get(tid);
        last.set(tid, key);
        if (prev === undefined || prev === key) continue;
        if (remote.current.get(t.id) === t.version) continue;
        const voteIds = new Set(votes.map((v) => v.id));
        const labels = labelsFor(all, voteIds);
        if (t.isDeleted) {
          for (const e of [...votes, ...labels]) updates.set(e.id, newElementWith(e, { isDeleted: true }));
          continue;
        }
        for (const v of votes) {
          const pos = slotPosition(t, cdOf(v).slot ?? 0);
          const dx = pos.x - v.x;
          const dy = pos.y - v.y;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
          updates.set(v.id, newElementWith(v, { x: pos.x, y: pos.y }));
          for (const l of labels) if (cdOf(l).voteId === v.id) updates.set(l.id, newElementWith(l, { x: l.x + dx, y: l.y + dy }));
        }
      }
      if (updates.size) api.updateScene({ elements: all.map((e) => updates.get(e.id) ?? e), captureUpdate: CaptureUpdateAction.NEVER });
    };
    const off = api.onChange(() => {
      if (!raf) raf = requestAnimationFrame(check);
    });
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [api, canEdit]);
}

/**
 * Changes whenever a vote is added or removed or a voted item moves, including remote changes (the shared scene
 * state only tracks scroll, zoom and selection, so it doesn't re-render for those).
 */
function useVotesKey(api: ExcalidrawImperativeAPI) {
  const [key, setKey] = useState('');
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const all = api.getSceneElements();
      const votes = all.filter(isVote);
      const targets = new Set(votes.map((v) => cdOf(v).targetId));
      const parts = votes.map((v) => `${v.id}:${cdOf(v).targetId}`);
      for (const e of all) if (targets.has(e.id)) parts.push(`${e.id}@${e.x},${e.y},${e.width},${e.height},${e.angle}`);
      const next = parts.join('|');
      setKey((prev) => (prev === next ? prev : next));
    };
    check();
    const off = api.onChange(() => {
      if (!raf) raf = requestAnimationFrame(check);
    });
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [api]);
  return key;
}

/** Vote button next to the selection (left of "Ask AI"), the U shortcut, count badges, and the sticker follower. */
export function Votes(props: { api: ExcalidrawImperativeAPI; scene: SceneState; collab: CollabApi; me: Voter | null; canEdit: boolean }) {
  const { api, scene, collab, me, canEdit } = props;
  useVoteFollower(api, collab, canEdit);
  const votesKey = useVotesKey(api);
  const targets = scene.selected.filter(isVotable);
  const meRef = useRef(me);
  meRef.current = me;

  const vote = useCallback(() => {
    const m = meRef.current;
    if (!m) return;
    const app = api.getAppState();
    const sel = api.getSceneElements().filter((e) => app.selectedElementIds[e.id]);
    toggleVotes(api, sel, m);
  }, [api]);

  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== VOTE_SHORTCUT.toLowerCase() || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isWritable(e.target) || isInOverlay(e.target) || api.getAppState().editingTextElement) return;
      const t = e.target;
      if (t instanceof Element && t !== document.body && !t.closest('.excalidraw-container')) return;
      const app = api.getAppState();
      if (!api.getSceneElements().some((el) => app.selectedElementIds[el.id] && isVotable(el))) return;
      e.preventDefault();
      vote();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [api, canEdit, vote]);

  // Count badges: one per voted item, everyone sees them (viewers too).
  const all = api.getSceneElements();
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of all) if (isVote(e)) m.set(cdOf(e).targetId ?? '', (m.get(cdOf(e).targetId ?? '') ?? 0) + 1);
    return m;
  }, [votesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = new Map(all.map((e) => [e.id, e]));
  const { app } = scene;
  const badges: React.ReactNode[] = [];
  for (const [tid, n] of counts) {
    const t = byId.get(tid);
    if (!t || n < 1) continue;
    const [, minY, maxX] = getCommonBounds([t]);
    const p = sceneToClient(maxX, minY, app);
    if (p.x < app.offsetLeft || p.y < app.offsetTop || p.x > app.offsetLeft + app.width || p.y > app.offsetTop + app.height) continue;
    badges.push(
      <div
        key={tid}
        className="pointer-events-none fixed z-[15] inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full border border-[var(--monet-border)] bg-[var(--monet-text-strong)] px-1.5 text-[11px] font-bold text-[var(--monet-canvas)] shadow-[0_2px_8px_var(--monet-shadow)]"
        style={{ left: p.x + 4, top: p.y - 10 - (SIZE / 2) * app.zoom.value }}
        title={`${n} vote${n === 1 ? '' : 's'}`}
        data-testid={`vote-badge-${tid}`}
      >
        <ThumbsUp className="h-2.5 w-2.5" /> {n}
      </div>,
    );
  }

  // The Vote button: placed like "Ask AI" (above the selection's right side), just to its left.
  let button: React.ReactNode = null;
  if (canEdit && me && targets.length && !scene.busy) {
    const [minX, minY, maxX, maxY] = getCommonBounds(targets);
    const tl = sceneToClient(minX, minY, app);
    const br = sceneToClient(maxX, maxY, app);
    const left = app.offsetLeft;
    const top = app.offsetTop;
    const right = left + app.width;
    const bottom = top + app.height;
    if (br.x > left && tl.x < right && br.y > top && tl.y < bottom) {
      const voted = targets.every((t) => votesOn(all, t.id).some((v) => cdOf(v).userId === me.id));
      const askW = 86;
      const w = voted ? 84 : 70;
      const askX = Math.min(Math.max(br.x - askW, left + 8), right - askW - 8);
      const x = Math.max(left + 8, askX - 8 - w);
      let y = tl.y - 52;
      if (y < top + 56) y = Math.min(br.y + 16, bottom - 44);
      button = (
        <button
          className="fixed z-30 flex items-center gap-1.5 rounded-full border border-[var(--monet-border-3)] bg-[var(--monet-surface-2)] px-3 py-1.5 text-[13px] font-medium text-[var(--monet-text-strong)] shadow-[0_4px_16px_var(--monet-shadow)] transition hover:bg-[var(--monet-surface-3)]"
          style={{ left: x, top: y, width: w }}
          onClick={vote}
          title={`${voted ? 'Remove your vote' : 'Vote with your face sticker'} (${VOTE_SHORTCUT})`}
          aria-pressed={voted}
          data-testid="button-vote-selection"
        >
          <span className="grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold" style={{ background: me.color, color: textOn(me.color) }}>
            {(me.name.trim()[0] ?? '?').toUpperCase()}
          </span>
          {voted ? 'Unvote' : 'Vote'}
        </button>
      );
    }
  }

  return (
    <Overlay>
      {badges}
      {button}
    </Overlay>
  );
}
