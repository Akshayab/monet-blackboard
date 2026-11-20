// The board's shared countdown: a stopwatch in the zoom pill (a stopwatch icon left of the zoom level).
// Editors start, pause, extend and reset it; everyone on the board sees the same time, and it chimes at zero.
import { useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import type { LocalTimer } from '@/board/use-collab';
import { ShellMenu, ShellMenuItem, ShellMenuSeparator } from './shell-menu';

const PRESETS = [1, 3, 5, 10, 15];

function remainingOf(t: LocalTimer, now: number) {
  return t.running && t.endsAt ? Math.max(0, t.endsAt - now) : t.remainingMs;
}

export function formatTimer(ms: number) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function chime() {
  try {
    const ctx = new AudioContext();
    [880, 660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.22);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + i * 0.22 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.22 + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.22);
      o.stop(ctx.currentTime + i * 0.22 + 0.21);
    });
    setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* audio unavailable */
  }
}

export function BoardTimerButton({
  timer,
  canEdit,
  onTimer,
}: {
  timer: LocalTimer | null;
  canEdit: boolean;
  onTimer: (action: 'start' | 'pause' | 'reset' | 'add', durationMs?: number) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timer?.running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [timer?.running, timer?.endsAt]);

  // `now` only drives re-renders; read the clock directly so a fresh timer never shows a stale, inflated value.
  const remaining = timer ? remainingOf(timer, Math.max(now, Date.now())) : 0;
  const done = !!timer && remaining <= 0;
  const chimed = useRef<number | null>(null);
  useEffect(() => {
    if (done && timer?.endsAt && chimed.current !== timer.endsAt) {
      chimed.current = timer.endsAt;
      chime();
    }
  }, [done, timer?.endsAt]);

  const label = timer ? (done ? "Time's up" : formatTimer(remaining)) : null;
  return (
    <ShellMenu
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className={
            'flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] tabular-nums transition hover:bg-[var(--monet-surface-3)] hover:text-[var(--monet-text-strong)] ' +
            (done
              ? 'animate-pulse text-[var(--monet-warn)]'
              : timer && remaining < 10_000 && timer.running
                ? 'text-[var(--monet-warn)]'
                : timer
                  ? 'text-[var(--monet-text)]'
                  : 'text-[var(--monet-text-faint)]')
          }
          aria-label={timer ? `Board timer: ${label}${timer.running ? '' : done ? '' : ', paused'}` : 'Board timer'}
          aria-haspopup="menu"
          title="Timer"
          data-testid="button-board-timer"
        >
          <Timer className="h-4 w-4" />
          {label && (
            <span data-testid="text-board-timer" data-running={timer?.running ? 'true' : 'false'}>
              {label}
            </span>
          )}
        </button>
      )}
    >
      {(close) => {
        const act = (action: 'start' | 'pause' | 'reset' | 'add', ms?: number) => () => {
          onTimer(action, ms);
          close();
        };
        if (!canEdit) {
          return (
            <div className="px-3 py-2 text-[12px] text-[var(--monet-text-muted)]" data-testid="text-timer-readonly">
              {timer ? `${label}${timer.by ? ` · set by ${timer.by}` : ''}` : 'No timer running.'}
              <div className="mt-1">Only editors can set the timer.</div>
            </div>
          );
        }
        return (
          <>
            {timer && (
              <>
                {timer.running ? (
                  <ShellMenuItem onSelect={act('pause')} testId="menu-timer-pause">
                    Pause
                  </ShellMenuItem>
                ) : !done ? (
                  <ShellMenuItem onSelect={act('start')} testId="menu-timer-resume">
                    Resume
                  </ShellMenuItem>
                ) : null}
                <ShellMenuItem onSelect={act('add')} testId="menu-timer-add">
                  Add 1 minute
                </ShellMenuItem>
                <ShellMenuItem onSelect={act('reset')} testId="menu-timer-reset">
                  {done ? 'Clear' : 'Reset'}
                </ShellMenuItem>
                <ShellMenuSeparator />
              </>
            )}
            <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--monet-text-muted)]">
              {timer ? 'Start over' : 'Start a timer for everyone'}
            </div>
            {PRESETS.map((m) => (
              <ShellMenuItem key={m} onSelect={act('start', m * 60_000)} testId={`menu-timer-${m}`}>
                {m} min
              </ShellMenuItem>
            ))}
          </>
        );
      }}
    </ShellMenu>
  );
}
