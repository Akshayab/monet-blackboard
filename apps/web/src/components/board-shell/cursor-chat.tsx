// Cursor chat: press "/" on the board to type a short message that floats next to your cursor for everyone
// else. Enter keeps it up for a few seconds; Escape clears it.
import { useEffect, useRef, useState } from 'react';
import { CURSOR_CHAT_MAX } from '@monet/board-protocol';
import type { BoardContext } from '@/board/slots';
import { sceneToClient } from '@/board/inputs/scene';
import { refocusCanvas } from '@/board/inputs/overlay';

const LINGER_MS = 5000;
const SEND_EVERY_MS = 120;

function typingSomewhere(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export function CursorChatLayer({ ctx }: { ctx: BoardContext }) {
  const api = ctx.excalidrawAPI;
  const collab = ctx.collab;
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState('');
  const pointer = useRef({ x: 0, y: 0 });
  const lastSent = useRef(0);
  const trailing = useRef<number | null>(null);
  const clearTimer = useRef<number | null>(null);
  const [, setTick] = useState(0);

  // My cursor position (client coordinates) for placing my own bubble.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      if (open) setOpen({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [open]);

  // "/" opens the bubble while the board has focus.
  useEffect(() => {
    if (!api) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || open || typingSomewhere()) return;
      if (api.getAppState().editingTextElement) return;
      if (!document.querySelector('.excalidraw')?.contains(document.activeElement) && document.activeElement !== document.body) return;
      e.preventDefault();
      e.stopPropagation();
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
      setText('');
      setOpen({ ...pointer.current });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [api, open]);

  const send = (value: string, now = false) => {
    if (trailing.current) window.clearTimeout(trailing.current);
    const go = () => {
      lastSent.current = Date.now();
      collab.sendCursorChat(value);
    };
    if (now || Date.now() - lastSent.current >= SEND_EVERY_MS) go();
    else trailing.current = window.setTimeout(go, SEND_EVERY_MS);
  };

  const finish = (keep: boolean) => {
    setOpen(null);
    if (keep && text.trim()) {
      send(text, true);
      clearTimer.current = window.setTimeout(() => collab.sendCursorChat(''), LINGER_MS);
    } else {
      send('', true);
    }
    setTimeout(refocusCanvas, 0);
  };

  // Remote bubbles follow their cursors: redraw every frame while any are showing, and drop stale ones.
  const chats = Object.entries(collab.cursorChats).filter(([, c]) => Date.now() - c.at < LINGER_MS * 3);
  useEffect(() => {
    if (!chats.length) return;
    let raf = 0;
    const loop = () => {
      setTick((t) => (t + 1) % 1_000_000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [chats.length]);

  if (!api) return null;
  const app = api.getAppState();
  const colorOf = (socketId: string) => collab.collaborators.find((c) => c.socketId === socketId)?.color ?? '#1971c2';
  const nameOf = (socketId: string) => collab.collaborators.find((c) => c.socketId === socketId)?.name ?? '';

  return (
    <>
      {chats.map(([socketId, c]) => {
        const p = collab.pointerOf(socketId);
        if (!p) return null;
        const at = sceneToClient(p.x, p.y, app);
        return (
          <div
            key={socketId}
            className="pointer-events-none fixed z-40 max-w-[260px] rounded-2xl rounded-tl-sm px-3 py-1.5 text-[13px] font-medium text-white shadow-[0_4px_14px_rgba(0,0,0,0.3)]"
            style={{ left: at.x + 14, top: at.y + 30, background: colorOf(socketId) }}
            data-testid={`cursor-chat-${socketId}`}
            aria-label={`${nameOf(socketId)} says ${c.text}`}
          >
            {c.text}
          </div>
        );
      })}
      {open && (
        <div className="fixed z-40" style={{ left: open.x + 14, top: open.y + 18 }}>
          <input
            autoFocus
            value={text}
            maxLength={CURSOR_CHAT_MAX}
            onChange={(e) => {
              setText(e.target.value);
              send(e.target.value);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') finish(true);
              if (e.key === 'Escape') finish(false);
            }}
            onBlur={() => finish(true)}
            placeholder="Say something"
            className="w-[220px] rounded-2xl rounded-tl-sm border-0 px-3 py-1.5 text-[13px] font-medium text-white shadow-[0_4px_14px_rgba(0,0,0,0.3)] outline-none placeholder:text-white/95"
            style={{ background: collab.me?.color ?? '#1971c2' }}
            data-testid="input-cursor-chat"
          />
        </div>
      )}
    </>
  );
}
