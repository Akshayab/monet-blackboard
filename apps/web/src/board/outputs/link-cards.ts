// Link cards: a card on the board that opens a doc, a deck, or another board made from this one.
// A rounded card with a title and a kind label, carrying the target in `link` (Excalidraw shows a link
// button on it) and in customData { kind: 'link-card', target, targetId, url } for tests and the AI.
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { DARK_PALETTE, SMALL_ROUNDNESS, type SceneElement } from '@monet/board-protocol';
import { findFreeSpot, insertElements, viewportCenter } from '../inputs/scene';

export type LinkTarget = 'doc' | 'deck' | 'board';

export interface LinkCardData {
  kind: 'link-card';
  target: LinkTarget;
  targetId: string;
  url: string;
  title: string;
}

const LABEL: Record<LinkTarget, string> = { doc: 'Doc', deck: 'Deck', board: 'Board' };
const ICON: Record<LinkTarget, string> = { doc: '📄', deck: '📊', board: '🗂️' };
const W = 280;
const H = 96;

export function isLinkCard(e: { customData?: unknown }): boolean {
  return (e.customData as { kind?: string } | undefined)?.kind === 'link-card';
}

/** The link card already on the board for a target, if any. */
export function findLinkCard(api: ExcalidrawImperativeAPI, targetId: string) {
  return api.getSceneElements().find((e) => isLinkCard(e) && (e.customData as LinkCardData).targetId === targetId) ?? null;
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/**
 * Adds a link card near the middle of the view (or next to `near`), unless one for the same target is there.
 * Returns the card's id.
 */
export function addLinkCard(
  api: ExcalidrawImperativeAPI,
  card: { target: LinkTarget; targetId: string; url: string; title: string },
  opts: { select?: boolean; scrollIntoView?: boolean } = {},
): string | null {
  const existing = findLinkCard(api, card.targetId);
  if (existing) return existing.id;
  const spot = findFreeSpot(api, viewportCenter(api.getAppState()), W, H);
  const data: LinkCardData = { kind: 'link-card', ...card };
  const text = `${ICON[card.target]}  ${LABEL[card.target]}\n${truncate(card.title, 60)}`;
  const els = convertToExcalidrawElements([
    {
      type: 'rectangle',
      x: spot.x,
      y: spot.y,
      width: W,
      height: H,
      backgroundColor: '#262626',
      strokeColor: DARK_PALETTE.ACCENT,
      strokeWidth: 1,
      fillStyle: 'solid',
      roughness: 0,
      roundness: SMALL_ROUNDNESS,
      link: card.url,
      customData: data,
      label: {
        text,
        fontSize: 16,
        fontFamily: 6,
        strokeColor: DARK_PALETTE.TEXT_ON_DARK,
        textAlign: 'left',
        verticalAlign: 'middle',
      },
    } as never,
  ]);
  // The skeleton converter drops `link` on labeled containers, so set the card's link and data directly.
  const withLink = els.map((e) => (e.type === 'rectangle' ? { ...e, link: card.url, customData: data } : e));
  const inserted = insertElements(api, withLink as unknown as SceneElement[], { select: opts.select, scrollIntoView: opts.scrollIntoView ?? !spot.inView });
  return (inserted.find((e) => e.type === 'rectangle')?.id as string | undefined) ?? null;
}
