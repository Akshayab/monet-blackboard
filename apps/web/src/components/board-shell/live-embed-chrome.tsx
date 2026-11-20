// Live embeds (polls, timers, prototypes) carry an internal https://embed.monet.local/<kind> link that routes
// them to the sealed runner. Excalidraw shows an editable link box for any selected element with a link; editing
// it would break the embed, so the box is hidden while a live embed is the selection.
import { useEffect } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useSceneState } from '@/board/inputs/use-scene-state';

export function LiveEmbedChrome({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const scene = useSceneState(api);
  const live = !!scene && scene.selected.length > 0 && scene.selected.every((e) => (e.customData as { kind?: string } | undefined)?.kind === 'live-embed');
  useEffect(() => {
    const root = document.querySelector('.monet-canvas');
    root?.classList.toggle('monet-live-embed-selected', live);
    return () => root?.classList.remove('monet-live-embed-selected');
  }, [live]);
  return null;
}
