// AI suggestions ("find the gaps"): the AI adds elements marked customData.suggestion === true for people
// to review. Accept clears the flag and restyles them as normal content; Dismiss deletes them. Both are
// ordinary client-side scene edits, so they sync to everyone and can be undone.
//
// Conventions the server can use (all optional):
//   customData.suggestionId     -> elements sharing an id are reviewed as one unit
//   customData.suggestionReason -> short "why" shown in the review list
//   customData.acceptStyle      -> element props to apply on accept (otherwise dashed -> solid,
//                                  opacity -> 100, suggestion purple -> ink)
import { CaptureUpdateAction, getCommonBounds, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { DARK_PALETTE, swapThemeColor } from '@monet/board-protocol';
import { getTheme } from '@/lib/theme';
import type { SceneBounds } from './use-scene';

export const SUGGESTION_COLOR = DARK_PALETTE.SUGGESTION;
const SUGGESTION_KEYS = ['suggestion', 'suggestionId', 'suggestionReason', 'acceptStyle'];

export interface SuggestionUnit {
  key: string;
  /** Every element to accept/dismiss together (includes bound text). */
  ids: string[];
  label: string;
  reason: string | null;
  bounds: SceneBounds;
}

type Cd = Record<string, unknown> | undefined;
const cdOf = (e: ExcalidrawElement) => e.customData as Cd;

export function isSuggestion(e: ExcalidrawElement) {
  return !e.isDeleted && cdOf(e)?.suggestion === true;
}

function containerIdOf(e: ExcalidrawElement): string | null {
  return e.type === 'text' ? ((e as { containerId?: string | null }).containerId ?? null) : null;
}

export function findSuggestionUnits(elements: readonly ExcalidrawElement[]): SuggestionUnit[] {
  const live = elements.filter((e) => !e.isDeleted);
  const sugg = live.filter(isSuggestion);
  if (!sugg.length) return [];
  const byId = new Map(live.map((e) => [e.id, e]));

  const ownKey = (e: ExcalidrawElement): string => {
    const sid = cdOf(e)?.suggestionId;
    if (typeof sid === 'string' && sid) return `s:${sid}`;
    if (e.groupIds.length) return `g:${e.groupIds[e.groupIds.length - 1]}`;
    return `e:${e.id}`;
  };

  const keyOf = new Map<string, string>();
  const dependents: ExcalidrawElement[] = [];
  for (const e of sugg) {
    const hasSid = typeof cdOf(e)?.suggestionId === 'string';
    const cid = containerIdOf(e);
    const container = cid ? byId.get(cid) : undefined;
    if (!hasSid && container && isSuggestion(container)) dependents.push(e);
    else if (!hasSid && e.type === 'arrow' && !e.groupIds.length) dependents.push(e);
    else keyOf.set(e.id, ownKey(e));
  }
  for (const e of dependents) {
    const cid = containerIdOf(e);
    if (cid && keyOf.has(cid)) {
      keyOf.set(e.id, keyOf.get(cid)!);
      continue;
    }
    if (e.type === 'arrow') {
      const a = e as unknown as { startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null };
      const bound = [a.startBinding?.elementId, a.endBinding?.elementId].find((id) => id && keyOf.has(id));
      if (bound) {
        keyOf.set(e.id, keyOf.get(bound)!);
        continue;
      }
    }
    keyOf.set(e.id, ownKey(e));
  }

  const groups = new Map<string, Set<string>>();
  for (const [id, key] of keyOf) {
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(id);
  }

  const units: SuggestionUnit[] = [];
  for (const [key, idSet] of groups) {
    // Bound text of members belongs to the unit even when it isn't flagged itself.
    for (const id of [...idSet]) {
      const el = byId.get(id);
      for (const b of el?.boundElements ?? []) if (b.type === 'text' && byId.has(b.id)) idSet.add(b.id);
    }
    const members = [...idSet].map((id) => byId.get(id)!).filter(Boolean);
    if (!members.length) continue;
    const text = members.find((m) => m.type === 'text') as (ExcalidrawElement & { text?: string }) | undefined;
    const main = members.find((m) => m.type !== 'text') ?? members[0]!;
    const rawLabel = text?.text?.replace(/\s+/g, ' ').trim();
    const label = rawLabel
      ? rawLabel.length > 70
        ? `${rawLabel.slice(0, 68)}…`
        : rawLabel
      : main.type === 'arrow'
        ? 'Suggested connection'
        : 'Suggested item';
    const reason = members.map((m) => cdOf(m)?.suggestionReason).find((r): r is string => typeof r === 'string' && !!r) ?? null;
    const [minX, minY, maxX, maxY] = getCommonBounds(members);
    units.push({ key, ids: members.map((m) => m.id), label, reason, bounds: [minX, minY, maxX, maxY] });
  }
  units.sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
  return units;
}

export function suggestionUnitsEqual(a: SuggestionUnit[], b: SuggestionUnit[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.key !== y.key ||
      x.label !== y.label ||
      x.ids.join(',') !== y.ids.join(',') ||
      x.bounds.map(Math.round).join(',') !== y.bounds.map(Math.round).join(',')
    )
      return false;
  }
  return true;
}

/** Colors shown on screen are theme-swapped, so compare and assign in the current theme's display colors. */
const shown = (stored: string) => (getTheme() === 'light' ? (swapThemeColor(stored) as string) : stored);

/** The ordinary color a suggestion's purple turns into once it's accepted (readable on the canvas). */
function acceptedColor(el: ExcalidrawElement): string | null {
  const c = el.strokeColor.toLowerCase();
  if (c === DARK_PALETTE.SUGGESTION_TEXT_ON_FILL) return DARK_PALETTE.TEXT_ON_FILL;
  if (c === shown(DARK_PALETTE.SUGGESTION_TEXT)) return shown(DARK_PALETTE.TEXT_MUTED);
  if (c === SUGGESTION_COLOR) return el.type === 'text' ? shown(DARK_PALETTE.TEXT_MUTED) : shown(DARK_PALETTE.ARROW);
  return null;
}

function acceptElement(el: ExcalidrawElement): ExcalidrawElement {
  const cd = { ...((el.customData as Record<string, unknown> | undefined) ?? {}) };
  const wasFlagged = cd.suggestion === true;
  const acceptStyle = cd.acceptStyle;
  for (const k of SUGGESTION_KEYS) delete cd[k];
  const patch: Record<string, unknown> = { customData: Object.keys(cd).length ? cd : undefined };
  if (acceptStyle && typeof acceptStyle === 'object') {
    Object.assign(patch, acceptStyle);
  } else {
    if (wasFlagged && el.strokeStyle !== 'solid') patch.strokeStyle = 'solid';
    if (el.opacity < 100) patch.opacity = 100;
    const normal = acceptedColor(el);
    if (normal) patch.strokeColor = normal;
  }
  return newElementWith(el, patch as never);
}

function applyToUnits(api: ExcalidrawImperativeAPI, units: SuggestionUnit[], fn: (el: ExcalidrawElement) => ExcalidrawElement) {
  const ids = new Set(units.flatMap((u) => u.ids));
  if (!ids.size) return;
  const next = api.getSceneElementsIncludingDeleted().map((e) => (ids.has(e.id) && !e.isDeleted ? fn(e) : e));
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

export function acceptSuggestions(api: ExcalidrawImperativeAPI, units: SuggestionUnit[]) {
  applyToUnits(api, units, acceptElement);
}

export function dismissSuggestions(api: ExcalidrawImperativeAPI, units: SuggestionUnit[]) {
  const ids = new Set(units.flatMap((u) => u.ids));
  // Drop the selection of anything we delete so Excalidraw doesn't keep a ghost selection.
  const app = api.getAppState();
  const selected = Object.fromEntries(Object.entries(app.selectedElementIds).filter(([id]) => !ids.has(id)));
  applyToUnits(api, units, (el) => newElementWith(el, { isDeleted: true }));
  api.updateScene({ appState: { selectedElementIds: selected as never }, captureUpdate: CaptureUpdateAction.NEVER });
}

export function scrollToUnit(api: ExcalidrawImperativeAPI, unit: SuggestionUnit) {
  const ids = new Set(unit.ids);
  const els = api.getSceneElements().filter((e) => ids.has(e.id));
  if (els.length) api.scrollToContent(els, { animate: true, fitToViewport: false });
}
