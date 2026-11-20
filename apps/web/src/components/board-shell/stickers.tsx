// Stickers: pick an emoji in the tool pill, then click the board to stamp it. A sticker is an ordinary
// text element (customData.kind = "sticker"), so it syncs live, moves, resizes and deletes like anything else.
import { useEffect } from 'react';
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { insertElements } from '@/board/inputs/scene';
import type { SceneElement } from '@monet/board-protocol';

export const STICKER_TOOL = 'sticker';
export const STICKERS = ['👍', '❤️', '🎉', '✅', '❓', '⭐', '🔥', '💡', '👀', '🚀', '⚠️', '😂'] as const;

let currentSticker: string = STICKERS[0];
export const stickerState = {
  get: () => currentSticker,
  set: (s: string) => {
    currentSticker = s;
  },
};

export function activateSticker(api: ExcalidrawImperativeAPI, sticker: string) {
  stickerState.set(sticker);
  api.setActiveTool({ type: 'custom', customType: STICKER_TOOL });
  api.setCursor('crosshair');
}

export function placeSticker(api: ExcalidrawImperativeAPI, x: number, y: number, sticker = stickerState.get()) {
  const size = 48;
  const [el] = convertToExcalidrawElements([
    {
      type: 'text',
      x: x - size / 2,
      y: y - size / 2,
      text: sticker,
      fontSize: size,
      fontFamily: 6,
      strokeColor: '#f5f5f5',
      customData: { kind: 'sticker' },
    } as never,
  ]);
  if (!el) return null;
  insertElements(api, [el as unknown as SceneElement], { select: false, restore: false });
  return el.id;
}

/** Stamps the chosen sticker where the board is clicked while the sticker tool is active. */
export function useStickerTool(api: ExcalidrawImperativeAPI | null) {
  useEffect(() => {
    if (!api) return;
    return api.onPointerUp((activeTool, pointerDownState) => {
      if (activeTool.type !== 'custom' || activeTool.customType !== STICKER_TOOL) return;
      const { x, y } = pointerDownState.origin;
      setTimeout(() => {
        placeSticker(api, x, y);
        api.setActiveTool({ type: 'selection' });
      }, 0);
    });
  }, [api]);
}
