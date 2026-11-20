// Keeps the open board in step with the app theme: canvas background, default ink, and the theme-dependent
// element colors (swapped locally, versions untouched, so nothing is re-sent to collaborators).
import { useEffect, useRef } from 'react';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { swapThemeColors } from '@monet/board-protocol';
import { BOARD_THEME, useTheme } from '@/lib/theme';

export function useBoardThemeSync(api: ExcalidrawImperativeAPI | null) {
  const theme = useTheme();
  const shown = useRef(theme);
  useEffect(() => {
    if (!api) return;
    const t = BOARD_THEME[theme];
    const app = api.getAppState();
    const switched = shown.current !== theme;
    shown.current = theme;
    api.updateScene({
      ...(switched ? { elements: swapThemeColors(api.getSceneElementsIncludingDeleted(), theme) as never } : {}),
      appState: {
        viewBackgroundColor: t.background,
        // Keep a person's chosen ink unless it was the other theme's default.
        currentItemStrokeColor:
          app.currentItemStrokeColor === BOARD_THEME.dark.stroke || app.currentItemStrokeColor === BOARD_THEME.light.stroke
            ? t.stroke
            : app.currentItemStrokeColor,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [api, theme]);
  return theme;
}
