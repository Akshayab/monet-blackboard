// Lock / unlock in Excalidraw's properties panel. Excalidraw 0.18 offers Group / Ungroup in the panel and Lock in
// the element context menu (right-click a locked item to get Unlock), but no lock button in the panel. This adds one
// to the panel's "Actions" row, styled like its neighbours. Locking changes `locked` on the elements, so it syncs
// live like any other edit.
import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { SceneState } from './use-scene-state';

const LOCKED = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);
const UNLOCKED = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.5-2" />
  </svg>
);

/** Locks (or unlocks, when everything selected is locked) the selection and its bound text. */
export function toggleLock(api: ExcalidrawImperativeAPI) {
  const app = api.getAppState();
  const all = api.getSceneElementsIncludingDeleted();
  const selected = all.filter((e) => !e.isDeleted && app.selectedElementIds[e.id]);
  if (!selected.length) return;
  const ids = new Set(selected.map((e) => e.id));
  for (const e of all) if (!e.isDeleted && e.type === 'text' && 'containerId' in e && e.containerId && ids.has(e.containerId)) ids.add(e.id);
  const lock = !selected.every((e) => e.locked);
  api.updateScene({
    elements: all.map((e) => (ids.has(e.id) && e.locked !== lock ? newElementWith(e, { locked: lock }) : e)),
    // Locked items can't stay selected (same as Excalidraw's own Lock action).
    appState: lock ? ({ selectedElementIds: {}, selectedGroupIds: {} } as never) : undefined,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

/** Finds the panel's Actions button row (the fieldset holding the delete / duplicate buttons). */
function findActionsRow(): HTMLElement | null {
  for (const fs of document.querySelectorAll<HTMLElement>('.monet-canvas .App-menu__left fieldset, .excalidraw .App-menu__left fieldset')) {
    const legend = fs.querySelector('legend')?.textContent?.trim().toLowerCase();
    const row = fs.querySelector<HTMLElement>('.buttonList');
    if (row && (legend === 'actions' || row.querySelector('[data-testid="deleteSelectedElements"], [aria-label="Delete"]'))) return row;
  }
  return null;
}

export function LockButton({ api, scene }: { api: ExcalidrawImperativeAPI; scene: SceneState }) {
  const [slot, setSlot] = useState<{ host: HTMLElement; className: string } | null>(null);
  const selectionKey = scene.selected.map((e) => `${e.id}:${e.version}`).join(',');

  // The panel re-renders with the selection; re-attach our slot after every change.
  useLayoutEffect(() => {
    const row = scene.selected.length ? findActionsRow() : null;
    if (!row) {
      setSlot(null);
      return;
    }
    let host = row.querySelector<HTMLElement>(':scope > [data-monet-lock-slot]');
    if (!host) {
      host = document.createElement('span');
      host.setAttribute('data-monet-lock-slot', '');
      host.style.display = 'contents';
      row.appendChild(host);
    }
    const sibling = row.querySelector<HTMLElement>(':scope > button');
    const className = sibling?.className ?? 'ToolIcon_type_button ToolIcon_size_medium ToolIcon_type_button--show ToolIcon';
    setSlot((prev) => (prev?.host === host && prev.className === className ? prev : { host: host!, className }));
  }, [selectionKey, scene.busy]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => document.querySelectorAll('[data-monet-lock-slot]').forEach((n) => n.remove()), []);

  if (!slot || !slot.host.isConnected) return null;
  const allLocked = scene.selected.length > 0 && scene.selected.every((e) => e.locked);
  const label = allLocked ? 'Unlock' : 'Lock';
  return createPortal(
    <button
      type="button"
      className={slot.className}
      title={`${label} (Ctrl+Shift+L)`}
      aria-label={label}
      onClick={() => toggleLock(api)}
      data-testid="button-panel-lock"
    >
      <div className="ToolIcon__icon" aria-hidden>
        {allLocked ? UNLOCKED : LOCKED}
      </div>
    </button>,
    slot.host,
  );
}
