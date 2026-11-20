// AI usage meter: today's AI requests for the signed-in user, with details on click. Mount it anywhere
// (home header, AI panel). Call refreshAiUsage() after an AI run so every mounted meter updates.
import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { Sparkles } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

export interface AiUsage {
  requestsUsed: number;
  requestLimit: number;
  tokensUsed: number;
  tokenLimit: number;
  resetsAt: string | null;
  running?: number;
  concurrentLimit?: number;
  paused?: boolean;
  pausedReason?: 'disabled' | 'global_budget' | null;
}

export interface AiUsageResponse {
  usage: AiUsage;
  configured: boolean;
}

const EVENT = 'monet:ai-usage-refresh';

/** Ask every mounted UsageMeter (and useAiUsage hook) to refetch. */
export function refreshAiUsage() {
  window.dispatchEvent(new Event(EVENT));
}

/** Fetches /api/ai/usage, refreshing on refreshAiUsage(), window focus, and every minute. */
export function useAiUsage() {
  const [data, setData] = useState<AiUsageResponse | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<AiUsageResponse>('/ai/usage'));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const onRefresh = () => void load();
    window.addEventListener(EVENT, onRefresh);
    window.addEventListener('focus', onRefresh);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => {
      window.removeEventListener(EVENT, onRefresh);
      window.removeEventListener('focus', onRefresh);
      clearInterval(timer);
    };
  }, [load]);
  return { data, error, reload: load };
}

function pct(used: number, limit: number) {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function usageStatus(data: AiUsageResponse | null): { label: string; tone: 'ok' | 'warn' | 'blocked' | 'off' } {
  if (!data) return { label: 'AI', tone: 'ok' };
  const u = data.usage;
  if (!data.configured) return { label: 'AI not set up', tone: 'off' };
  if (u.paused) return { label: 'AI paused', tone: 'off' };
  const reqLeft = Math.max(0, u.requestLimit - u.requestsUsed);
  if (reqLeft === 0 || u.tokensUsed >= u.tokenLimit) return { label: 'AI limit reached', tone: 'blocked' };
  const p = Math.max(pct(u.requestsUsed, u.requestLimit), pct(u.tokensUsed, u.tokenLimit));
  return { label: `${reqLeft} AI left`, tone: p >= 80 ? 'warn' : 'ok' };
}

export function UsageMeter({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { data, error } = useAiUsage();
  if (error && !data) return null;
  const status = usageStatus(data);
  const u = data?.usage;
  const reqPct = u ? pct(u.requestsUsed, u.requestLimit) : 0;
  const tokPct = u ? pct(u.tokensUsed, u.tokenLimit) : 0;
  const resets = u?.resetsAt ? formatDistanceToNowStrict(new Date(u.resetsAt), { addSuffix: true }) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition hover:bg-muted',
            status.tone === 'warn' && 'border-[var(--monet-warn-border)] text-[var(--monet-warn)]',
            status.tone === 'blocked' && 'border-destructive/40 text-destructive-text',
            status.tone === 'off' && 'text-muted-foreground',
            className,
          )}
          aria-label="AI usage"
          data-testid="button-ai-usage"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {!compact && <span data-testid="text-ai-usage-label">{data ? status.label : 'AI'}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-sm" data-testid="panel-ai-usage">
        <div className="font-medium">Today's AI usage</div>
        {!data ? (
          <p className="mt-2 text-muted-foreground">Loading…</p>
        ) : !data.configured ? (
          <p className="mt-2 text-muted-foreground">The board AI isn't set up on this server yet.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {u!.paused && (
              <p className="rounded-md bg-muted px-2 py-1.5 text-xs" data-testid="text-ai-paused">
                {u!.pausedReason === 'disabled' ? 'Monet AI is turned off right now.' : 'Monet AI has reached its daily capacity. Try again later.'}
              </p>
            )}
            <div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Requests</span>
                <span data-testid="text-ai-requests">
                  {u!.requestsUsed} / {u!.requestLimit}
                </span>
              </div>
              <Progress value={reqPct} className="mt-1 h-1.5" />
            </div>
            <div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Tokens</span>
                <span data-testid="text-ai-tokens">
                  {Intl.NumberFormat(undefined, { notation: 'compact' }).format(u!.tokensUsed)} /{' '}
                  {Intl.NumberFormat(undefined, { notation: 'compact' }).format(u!.tokenLimit)}
                </span>
              </div>
              <Progress value={tokPct} className="mt-1 h-1.5" />
            </div>
            <p className="text-xs text-muted-foreground">
              Limits reset on a rolling 24-hour window{resets ? `; your oldest request frees up ${resets}` : ''}.
              {u!.running ? ` ${u!.running} request${u!.running > 1 ? 's' : ''} running now.` : ''}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
