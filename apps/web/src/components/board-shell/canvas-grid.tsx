// Faint square grid over the dark board. Excalidraw's own grid draws light lines meant for a
// white canvas, so this is a pointer-events-none overlay synced to scroll and zoom. mix-blend-mode: lighten
// means it only shows where the board is darker than the grid lines (the empty canvas), never on cards.
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { BOARD_THEME, useTheme } from '@/lib/theme';
import { useSceneState } from '@/board/inputs/use-scene-state';

const GRID_SCENE = 40;

export function CanvasGrid({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const scene = useSceneState(api);
  const theme = useTheme();
  if (!scene) return null;
  const { zoom, scrollX, scrollY } = scene.app;
  let size = GRID_SCENE * zoom.value;
  // Keep cells readable when zoomed far out (and not huge when zoomed in).
  while (size < 18) size *= 2;
  while (size > 160) size /= 2;
  const ox = (((scrollX * zoom.value) % size) + size) % size;
  const oy = (((scrollY * zoom.value) % size) + size) % size;
  const line = BOARD_THEME[theme].grid;
  return (
    <div
      aria-hidden
      className="monet-canvas-grid pointer-events-none absolute inset-0"
      data-testid="canvas-grid"
      style={{
        backgroundImage: `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
        backgroundSize: `${size}px ${size}px`,
        backgroundPosition: `${ox}px ${oy}px`,
        mixBlendMode: BOARD_THEME[theme].blend,
      }}
    />
  );
}
