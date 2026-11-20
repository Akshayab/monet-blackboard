// Comments: pick the comment tool, click the board, type, Save. A comment is a small locked pin element
// (an ellipse with the author's initial, customData.kind = "comment" plus author, time and text), so it syncs
// live and persists with the board like any element. This layer draws a clickable marker over every pin and
// opens a card to read, edit or delete it. Viewers can read comments but not add them.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { X } from 'lucide-react';
import type { BoardContext } from '@/board/slots';
import { clampToWindow, Overlay, refocusCanvas } from '@/board/inputs/overlay';
import { clientToScene, insertElements, sceneToClient } from '@/board/inputs/scene';
import { useSceneState } from '@/board/inputs/use-scene-state';
import type { SceneElement } from '@monet/board-protocol';
import { dispatchAiSend, mentionsAi, stripAiMention } from '@/board/ai/send-event';

export const COMMENT_TOOL = 'comment';
const PIN = 30;

interface CommentData {
  kind: 'comment';
  authorId: string | null;
  authorName: string;
  createdAt: string;
  editedAt?: string;
  text: string;
  /** The item the comment is pinned to, when it was placed on one. */
  targetId?: string;
  /** The comment was also sent to the board AI as a request. */
  sentToAi?: boolean;
}

const isComment = (e: ExcalidrawElement) => e.type === 'ellipse' && (e.customData as { kind?: string } | undefined)?.kind === 'comment';

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// Commenters see the board in view mode, where Excalidraw's custom tools don't run; their comment tool is a
// placement mode with its own click-catching layer instead.
const placingListeners = new Set<() => void>();
let placingNow = false;
export function startCommentPlacement(on = true) {
  placingNow = on;
  placingListeners.forEach((l) => l());
}
export function useCommentPlacing() {
  return useSyncExternalStore(
    (l) => {
      placingListeners.add(l);
      return () => placingListeners.delete(l);
    },
    () => placingNow,
    () => false,
  );
}

export function activateComment(api: ExcalidrawImperativeAPI) {
  api.setActiveTool({ type: 'custom', customType: COMMENT_TOOL });
  api.setCursor('crosshair');
}

type Draft = { mode: 'new'; x: number; y: number; targetId: string | null } | { mode: 'view'; id: string };

/** The topmost item under a scene point (comments pin to it so the AI knows what they're about). */
function itemAt(api: ExcalidrawImperativeAPI, x: number, y: number): string | null {
  const els = api.getSceneElements();
  for (let i = els.length - 1; i >= 0; i--) {
    const e = els[i]!;
    if (e.isDeleted || isComment(e) || (e.type === 'text' && e.containerId)) continue;
    if (x >= e.x && x <= e.x + e.width && y >= e.y && y <= e.y + e.height) return e.id;
  }
  return null;
}

export function CommentLayer({ ctx }: { ctx: BoardContext }) {
  const api = ctx.excalidrawAPI;
  const scene = useSceneState(api);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  // "Send to AI": an @mention plus a "Send to AI" checkbox in the comment box.
  const [sendToAi, setSendToAi] = useState(false);
  const sendTouched = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const me = ctx.collab.me;
  const myId = me?.userId ?? ctx.user?.id ?? null;
  const myName = me?.name ?? ctx.user?.displayName ?? 'Someone';
  const canAskAi = ctx.canEdit && !!ctx.user;
  const myColor = me?.color ?? '#1971c2';
  const placing = useCommentPlacing();

  // Clicking the board with the comment tool opens a new comment card there.
  useEffect(() => {
    if (!api) return;
    return api.onPointerUp((activeTool, pointerDownState) => {
      if (activeTool.type !== 'custom' || activeTool.customType !== COMMENT_TOOL) return;
      const { x, y } = pointerDownState.origin;
      setTimeout(() => {
        api.setActiveTool({ type: 'selection' });
        setText('');
        setEditing(true);
        setDraft({ mode: 'new', x, y, targetId: itemAt(api, x, y) });
      }, 0);
    });
  }, [api]);

  useEffect(() => {
    if (draft && editing) setTimeout(() => inputRef.current?.focus(), 0);
  }, [draft, editing]);

  // Re-read when elements change, including remote ones (useSceneState only tracks view and selection).
  const [commentKey, setCommentKey] = useState('');
  useEffect(() => {
    if (!api) return;
    const read = () => {
      const key = api
        .getSceneElements()
        .filter(isComment)
        .map((e) => `${e.id}:${e.version}`)
        .join(',');
      setCommentKey((k) => (k === key ? k : key));
    };
    read();
    return api.onChange(read);
  }, [api]);
  const comments = useMemo(
    () => (api ? api.getSceneElements().filter(isComment) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, commentKey],
  );

  if (!api || !scene) return null;
  const app = scene.app;

  const close = () => {
    startCommentPlacement(false);
    setDraft(null);
    setEditing(false);
    setSendToAi(false);
    sendTouched.current = false;
    setTimeout(refocusCanvas, 0);
  };

  const save = () => {
    const body = text.trim();
    if (!body || !draft) return;
    if (draft.mode === 'new') {
      const data: CommentData = {
        kind: 'comment',
        authorId: myId,
        authorName: myName,
        createdAt: new Date().toISOString(),
        text: body,
        ...(draft.targetId ? { targetId: draft.targetId } : {}),
        ...(sendToAi && canAskAi ? { sentToAi: true } : {}),
      };
      const els = convertToExcalidrawElements([
        {
          type: 'ellipse',
          x: draft.x - PIN / 2,
          y: draft.y - PIN / 2,
          width: PIN,
          height: PIN,
          backgroundColor: myColor,
          strokeColor: myColor,
          fillStyle: 'solid',
          roughness: 0,
          strokeWidth: 1,
          locked: true,
          customData: data,
          label: { text: (myName.trim()[0] ?? '?').toUpperCase(), fontSize: 14, fontFamily: 6, strokeColor: '#ffffff' },
        } as never,
      ]);
      insertElements(api, els as unknown as SceneElement[], { select: false, restore: false });
      if (sendToAi && canAskAi) {
        const prompt = stripAiMention(body) || body;
        dispatchAiSend({ boardId: ctx.boardId, prompt, focusElementIds: draft.targetId ? [draft.targetId] : undefined });
      }
    } else {
      const target = api.getSceneElements().find((e) => e.id === draft.id);
      if (target) {
        const cd = { ...(target.customData as CommentData), text: body, editedAt: new Date().toISOString() };
        api.updateScene({
          elements: api.getSceneElementsIncludingDeleted().map((e) => (e.id === target.id ? newElementWith(e, { customData: cd }) : e)),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      }
    }
    close();
  };

  const remove = (id: string) => {
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map((e) => (e.id === id || (e.type === 'text' && e.containerId === id) ? newElementWith(e, { isDeleted: true }) : e)),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    close();
  };

  const viewing = draft?.mode === 'view' ? (comments.find((c) => c.id === draft.id) ?? null) : null;
  const viewData = viewing ? (viewing.customData as CommentData) : null;
  const anchorScene = draft?.mode === 'new' ? { x: draft.x, y: draft.y } : viewing ? { x: viewing.x + PIN, y: viewing.y } : null;
  const anchor = anchorScene ? sceneToClient(anchorScene.x, anchorScene.y, app) : null;
  const canModify = !!viewData && (ctx.canEdit || ctx.role === 'commenter') && (viewData.authorId === myId || ctx.role === 'owner');
  const card = anchor ? clampToWindow(anchor.x + 10, anchor.y - 8, 280, 200) : null;

  return (
    <Overlay>
      {placing && !ctx.canEdit && ctx.role === 'commenter' && (
        <div
          className="fixed z-[14] cursor-crosshair"
          style={{ left: app.offsetLeft, top: app.offsetTop, width: app.width, height: app.height }}
          onClick={(e) => {
            const { x, y } = clientToScene(e.clientX, e.clientY, app);
            startCommentPlacement(false);
            setText('');
            setEditing(true);
            setDraft({ mode: 'new', x, y, targetId: itemAt(api, x, y) });
          }}
          data-testid="comment-placement-layer"
        />
      )}
      {comments.map((c) => {
        const p = sceneToClient(c.x, c.y, app);
        const size = c.width * app.zoom.value;
        const d = c.customData as CommentData;
        return (
          <button
            key={c.id}
            type="button"
            className="fixed z-[15] rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--monet-active-fg)]"
            style={{ left: p.x, top: p.y, width: size, height: size }}
            onClick={() => {
              setText(d.text);
              setEditing(false);
              setDraft({ mode: 'view', id: c.id });
            }}
            aria-label={`Comment by ${d.authorName}: ${d.text}`}
            title={`${d.authorName}: ${d.text}`}
            data-testid="comment-pin"
          />
        );
      })}
      {draft && card && (draft.mode === 'new' || viewData) && (
        <div
          className="fixed z-40 w-[280px] rounded-xl border border-[var(--monet-border-2)] bg-[var(--monet-surface)] p-3 text-[var(--monet-text-strong)] shadow-[0_12px_40px_rgba(0,0,0,0.5)]"
          style={card}
          role="dialog"
          aria-label="Comment"
          data-testid="popover-comment"
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
          }}
        >
          <div className="mb-2 flex items-center gap-2">
            <span
              className="grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold text-white"
              style={{ background: viewing?.backgroundColor ?? myColor }}
            >
              {((viewData?.authorName ?? myName).trim()[0] ?? '?').toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium" data-testid="text-comment-author">
              {viewData?.authorName ?? myName}
            </span>
            {viewData && <span className="text-[11px] text-[var(--monet-text-muted)]">{ago(viewData.editedAt ?? viewData.createdAt)}</span>}
            <button
              type="button"
              className="grid h-6 w-6 place-items-center rounded-md text-[var(--monet-text-muted)] hover:bg-[var(--monet-surface-3)] hover:text-[var(--monet-text-strong)]"
              onClick={close}
              aria-label="Close"
              data-testid="button-comment-close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {editing ? (
            <>
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (!sendTouched.current && draft.mode === 'new' && canAskAi) setSendToAi(mentionsAi(e.target.value));
                }}
                rows={3}
                placeholder={canAskAi && draft.mode === 'new' ? 'Add a comment, or @AI to ask Monet AI' : 'Add a comment'}
                className="block w-full resize-none rounded-lg border border-[var(--monet-border-2)] bg-[var(--monet-surface-2)] px-2.5 py-2 text-[13px] text-[var(--monet-text-strong)] outline-none placeholder:text-[var(--monet-text-muted)] focus:border-[var(--monet-border-3)]"
                data-testid="input-comment"
              />
              <div className="mt-2 flex items-center justify-end gap-1.5">
                {draft.mode === 'new' && canAskAi && (
                  <label className="mr-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--monet-text-soft)]">
                    <input
                      type="checkbox"
                      checked={sendToAi}
                      onChange={(e) => {
                        sendTouched.current = true;
                        setSendToAi(e.target.checked);
                      }}
                      className="h-3.5 w-3.5 accent-[#4d8ff7]"
                      data-testid="checkbox-comment-send-to-ai"
                    />
                    Send to Monet AI
                  </label>
                )}
                <button
                  type="button"
                  className="h-7 rounded-md px-2.5 text-[12px] text-[var(--monet-text-soft)] hover:bg-[var(--monet-surface-3)]"
                  onClick={close}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="h-7 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
                  onClick={save}
                  disabled={!text.trim()}
                  data-testid="button-comment-save"
                >
                  {draft.mode === 'new' ? 'Comment' : 'Save'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--monet-text-strong)]" data-testid="text-comment-body">
                {viewData?.text}
              </p>
              {canModify && viewing && (
                <div className="mt-2 flex justify-end gap-1.5">
                  <button
                    type="button"
                    className="h-7 rounded-md px-2.5 text-[12px] text-[var(--monet-text-soft)] hover:bg-[var(--monet-surface-3)]"
                    onClick={() => setEditing(true)}
                    data-testid="button-comment-edit"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="h-7 rounded-md px-2.5 text-[12px] text-[var(--monet-danger)] hover:bg-[var(--monet-danger-bg)]"
                    onClick={() => remove(viewing.id)}
                    data-testid="button-comment-delete"
                  >
                    Delete
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Overlay>
  );
}
