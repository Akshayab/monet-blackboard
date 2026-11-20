import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams, useSearch } from 'wouter';
import { Excalidraw, exportToBlob, exportToSvg } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { LogoMark } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { api, ApiError, type BoardSummary } from '@/lib/api';
import { useCollab } from '@/board/use-collab';
import { appPath, withLink } from '@/board/outputs/api';
import { BoardSlots, type BoardContext } from '@/board/slots';
import { embedProps } from '@/board/inputs/embeds';
import { useAiUi } from '@/board/ai/store';
import { useIsMobile } from '@/hooks/use-mobile';
import { DARK_PALETTE } from '@monet/board-protocol';
import { BoardTopBar } from '@/components/board-shell/top-bar';
import { CanvasGrid } from '@/components/board-shell/canvas-grid';
import { ZoomPill } from '@/components/board-shell/zoom-pill';
import { ToolPill } from '@/components/board-shell/tool-pill';
import { useBoardThemeSync } from '@/components/board-shell/theme-sync';
import { BOARD_THEME, getTheme, toStored } from '@/lib/theme';
import '@/components/board-shell/board-shell.css';

export default function BoardPage() {
  const params = useParams<{ id: string }>();
  const boardId = params.id!;
  const search = new URLSearchParams(useSearch());
  const linkToken = search.get('link');
  const [, navigate] = useLocation();
  const { user, refresh: refreshAuth } = useAuth();
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const collab = useCollab({ boardId, linkToken, excalidrawAPI });
  const { chatOpen } = useAiUi();
  const isMobile = useIsMobile();
  useBoardThemeSync(excalidrawAPI);

  useEffect(() => {
    api<{ board: BoardSummary }>(`/boards/${boardId}`, { linkToken })
      .then((d) => setBoard(d.board))
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not open this board.'));
  }, [boardId, linkToken]);

  // Team mode: the server closes the board socket when this browser's session ends (left in another tab). Refresh
  // who we are so RequireAuth shows the right page; if a new session exists (rejoined elsewhere), reconnect once.
  const { reconnect } = collab;
  const lastReconnect = useRef(0);
  useEffect(() => {
    if (collab.error?.code !== 'unauthenticated') return;
    let cancelled = false;
    api<{ user: unknown }>('/auth/user').then(
      (d) => {
        if (cancelled) return;
        void refreshAuth();
        if (d.user && Date.now() - lastReconnect.current > 10_000) {
          lastReconnect.current = Date.now();
          reconnect();
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [collab.error, reconnect, refreshAuth]);

  const role = collab.role ?? board?.role ?? null;
  const canEdit = role === 'owner' || role === 'editor';
  const title = collab.title || board?.title || 'Untitled board';

  // Periodically save a small thumbnail for the library.
  const thumbTimer = useRef<NodeJS.Timeout | null>(null);
  const saveThumbnail = useCallback(async () => {
    if (!excalidrawAPI || !canEdit) return;
    // Thumbnails use the stored (dark) colors whatever theme this person is in.
    const elements = toStored(excalidrawAPI.getSceneElements());
    if (!elements.length) return;
    try {
      const files = excalidrawAPI.getFiles();
      const appState = { exportBackground: true, viewBackgroundColor: DARK_PALETTE.CANVAS_BG };
      // SVG when the board has no images and stays small, so light mode can recolor it (see thumbnailForTheme).
      let dataUrl: string | null = null;
      if (!elements.some((e) => e.type === 'image')) {
        const svg = await exportToSvg({ elements, files, appState, exportPadding: 10, skipInliningFonts: true });
        svg.setAttribute('width', '480');
        svg.removeAttribute('height');
        const bytes = new TextEncoder().encode(svg.outerHTML);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const encoded = btoa(bin);
        if (encoded.length < 400_000) dataUrl = `data:image/svg+xml;base64,${encoded}`;
      }
      if (!dataUrl) {
        const blob = await exportToBlob({ elements, files, appState, maxWidthOrHeight: 480, mimeType: 'image/webp', quality: 0.7 });
        dataUrl = await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.readAsDataURL(blob);
        });
      }
      await api(`/boards/${boardId}`, { method: 'PATCH', json: { thumbnail: dataUrl }, linkToken });
    } catch {
      /* thumbnails are best effort */
    }
  }, [boardId, canEdit, excalidrawAPI, linkToken]);

  const onChange: typeof collab.onChange = useCallback(
    (elements, appState, files) => {
      collab.onChange(elements, appState, files);
      if (thumbTimer.current) clearTimeout(thumbTimer.current);
      thumbTimer.current = setTimeout(() => void saveThumbnail(), 8000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collab.onChange, saveThumbnail],
  );

  const ctx: BoardContext = useMemo(
    () => ({ boardId, linkToken, excalidrawAPI, collab, board, role, canEdit, user }),
    [boardId, linkToken, excalidrawAPI, collab, board, role, canEdit, user],
  );

  if (loadError || collab.error?.code === 'forbidden' || collab.error?.code === 'deleted') {
    return (
      <div className="min-h-screen grid place-items-center bg-background px-6">
        <div className="text-center max-w-sm">
          <LogoMark className="h-10 w-10 mx-auto" />
          <h1 className="mt-4 text-xl font-semibold">Can't open this board</h1>
          <p className="mt-2 text-sm text-muted-foreground" data-testid="text-board-error">
            {collab.error?.message ?? loadError}
          </p>
          {collab.error?.code !== 'deleted' && (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="text-board-access-hint">
              Ask the board's owner for a working link.
            </p>
          )}
          <Button className="mt-6" onClick={() => navigate('/')}>
            Back to your boards
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="monet-board fixed inset-0 flex flex-col" data-testid="page-board">
      <BoardTopBar ctx={ctx} title={title} onTitleSaved={(t) => setBoard((b) => (b ? { ...b, title: t } : b))} isMobile={isMobile} />
      <div className="relative flex min-h-0 flex-1">
        {/* Left split chat; on phones it opens as a full-screen sheet instead. */}
        <div className={chatOpen && !isMobile ? 'h-full w-[380px] max-w-[45vw] shrink-0 border-r border-[#262626]' : 'contents'}>
          <BoardSlots.LeftPanel ctx={ctx} />
        </div>
        <div className="monet-canvas relative min-w-0 flex-1">
          <Excalidraw
            excalidrawAPI={setExcalidrawAPI}
            onChange={onChange}
            onPointerUpdate={collab.onPointerUpdate}
            isCollaborating
            {...embedProps}
            viewModeEnabled={!canEdit && role !== null}
            onUserFollow={(p) => collab.follow(p.action === 'FOLLOW' ? (p.userToFollow.socketId as string) : null)}
            onLinkOpen={(element, event) => {
              // Link cards store app paths (/b/…, /b/…/docs/…): open them in a new tab, keeping a share link's
              // access for this board's own docs and decks.
              const link = element.link ?? '';
              if (!link.startsWith('/')) return;
              event.preventDefault();
              const own = link.startsWith(`/b/${boardId}/`);
              window.open(appPath(own ? withLink(link, linkToken) : link), '_blank', 'noopener');
            }}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: false,
                changeViewBackgroundColor: false,
                export: { saveFileToDisk: true },
              },
            }}
            initialData={{
              appState: {
                viewBackgroundColor: BOARD_THEME[getTheme()].background,
                currentItemStrokeColor: BOARD_THEME[getTheme()].stroke,
                currentItemFontFamily: 6,
                currentItemRoughness: 0,
                currentItemRoundness: 'round',
                frameRendering: { enabled: true, name: true, outline: false, clip: true },
              },
            }}
          >
            <BoardSlots.Children ctx={ctx} />
          </Excalidraw>
          <CanvasGrid api={excalidrawAPI} />
          <ZoomPill api={excalidrawAPI} canEdit={canEdit} timer={collab.timer} onTimer={collab.sendTimer} />
          <div
            className={'monet-bottom-dock pointer-events-none absolute inset-x-0 flex flex-col items-center gap-2 px-3 ' + (isMobile ? 'bottom-3' : 'bottom-4')}
          >
            <div className="pointer-events-auto flex w-full justify-center">
              <BoardSlots.PromptBar ctx={ctx} />
            </div>
            <ToolPill api={excalidrawAPI} canEdit={canEdit} canComment={role === 'commenter'} isMobile={isMobile} />
          </div>
        </div>
      </div>
    </div>
  );
}
