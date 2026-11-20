// While the AI runs: a rust outline around the area it is editing, a faint rust tint inside, and a filled
// pill on its top-left edge ("Pondering…" first, then "Working…" once elements start arriving). It doesn't
// block the canvas (pointer-events: none) and fades out when the run ends.
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useAiSession, type RunOverlay } from './ai-session';
import { toClient, type ViewTransform } from './use-scene';

const FADE_MS = 450;

export function WorkingOverlay({ view }: { view: ViewTransform }) {
  const { run } = useAiSession();
  const [shown, setShown] = useState<RunOverlay | null>(null);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (run) {
      setShown(run);
      setFading(false);
      return;
    }
    setFading(true);
    const t = setTimeout(() => {
      setShown(null);
      setFading(false);
    }, FADE_MS);
    return () => clearTimeout(t);
  }, [run]);

  if (!shown || !view.width) return null;
  const { region } = shown;
  const tl = toClient(view, region.x, region.y);
  const br = toClient(view, region.x + region.width, region.y + region.height);
  const left = view.offsetLeft;
  const top = view.offsetTop;
  const right = left + view.width;
  const bottom = top + view.height;
  if (br.x < left || tl.x > right || br.y < top || tl.y > bottom) return null;
  const x1 = Math.max(tl.x, left + 2);
  const y1 = Math.max(tl.y, top + 2);
  const x2 = Math.min(br.x, right - 2);
  const y2 = Math.min(br.y, bottom - 2);
  const label = shown.label;
  const opacity = fading ? 0 : 1;
  return (
    <>
      <div
        className="pointer-events-none fixed z-20 rounded-[12px] ease-out"
        style={{
          left: x1,
          top: y1,
          width: Math.max(24, x2 - x1),
          height: Math.max(24, y2 - y1),
          border: '1.5px solid #c96442',
          background: 'rgba(201,100,66,0.06)',
          opacity,
          transition: `left 300ms, top 300ms, width 300ms, height 300ms, opacity ${FADE_MS}ms`,
        }}
        data-testid="ai-working-overlay"
        data-source={shown.source}
        data-phase={shown.phase}
        data-state={fading ? 'fading' : 'active'}
      />
      <div
        className="pointer-events-none fixed z-20 flex items-center gap-1 rounded-full bg-primary px-2.5 py-[3px] text-[13px] font-medium text-primary-foreground shadow-[0_2px_10px_rgba(0,0,0,0.35)] ease-out"
        style={{ left: x1 + 10, top: Math.max(top + 4, y1 - 12), opacity, transition: `left 300ms, top 300ms, opacity ${FADE_MS}ms` }}
        data-testid="ai-working-pill"
      >
        <Sparkles className="h-3 w-3" />
        {label}
      </div>
    </>
  );
}
