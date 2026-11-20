// Small layout helpers shared by the board templates. Everything a template returns is ordinary
// Excalidraw element JSON built with the board-protocol factories, so people (and the AI) can edit it.
import { darkenElements, FONT, PALETTE, assignIndices, makeFrame, makeText, type SceneElement } from "@monet/board-protocol";

/** Marks every element as template-made (handy for analytics and for the AI to know where it came from). */
export function tag(elements: SceneElement[], templateId: string): SceneElement[] {
  for (const el of elements) {
    el.customData = { ...((el.customData as Record<string, unknown> | undefined) ?? {}), template: templateId };
  }
  return elements;
}

/**
 * Centers container-bound labels inside their shapes. The server only estimates text size, and clients
 * don't re-measure on first load, so we place each label by its center: center-aligned text renders around
 * x + width / 2, which keeps it centered even when the width estimate is a little off.
 */
export function centerBoundLabels(elements: SceneElement[]): SceneElement[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const el of elements) {
    if (el.type !== "text" || !el.containerId) continue;
    const box = byId.get(el.containerId as string);
    if (!box) continue;
    const w = el.width as number;
    const h = el.height as number;
    if (box.type === "arrow") {
      const pts = (box.points as [number, number][]) ?? [[0, 0]];
      const last = pts[pts.length - 1] ?? [0, 0];
      el.x = (box.x as number) + last[0] / 2 - w / 2;
      el.y = (box.y as number) + last[1] / 2 - h / 2;
      continue;
    }
    el.x = (box.x as number) + (box.width as number) / 2 - w / 2;
    el.y = (box.y as number) + (box.height as number) / 2 - h / 2;
  }
  return elements;
}

// Templates are written with the original light palette; darkenElements maps them onto the dark board.
export function darkTheme(elements: SceneElement[]): SceneElement[] {
  for (const e of elements) if (typeof e.roughness === "number") e.roughness = 0;
  darkenElements(elements);
  return elements;
}

/** Final pass for a template: label placement, z-order keys, template tag. */
export function finalize(elements: SceneElement[], templateId: string): SceneElement[] {
  darkTheme(elements);
  centerBoundLabels(elements);
  tag(elements, templateId);
  return assignIndices(elements, null);
}

export function heading(text: string, x: number, y: number, fontSize = 36): SceneElement {
  return makeText({ text, x, y, fontSize, fontFamily: FONT.handDrawn, strokeColor: PALETTE.ink });
}

export function hint(text: string, x: number, y: number, fontSize = 18, frameId?: string): SceneElement {
  return makeText({ text, x, y, fontSize, fontFamily: FONT.normal, strokeColor: PALETTE.muted, frameId: frameId ?? null });
}

/** A section with its contents. Returns [frame, ...children] with every child's frameId pointed at the frame. */
export function section(
  name: string,
  box: { x: number; y: number; width: number; height: number },
  build: (frameId: string) => SceneElement[],
): SceneElement[] {
  const frame = makeFrame({ name, ...box });
  const children = build(frame.id);
  for (const c of children) c.frameId = frame.id;
  return [frame, ...children];
}
