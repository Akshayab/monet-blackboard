// "Turn this board into a doc / deck": pick a kind of document, optionally add instructions, choose
// the whole board or the selection, then watch the AI write it.
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, Loader2, PauseCircle, Presentation, Sparkles, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { BoardContext } from '../slots';
import {
  appPath,
  createDocument,
  errorMessage,
  getDocument,
  getOutputsConfig,
  isAiPausedError,
  selectedElements,
  withLink,
  type BoardDocument,
  type DocKind,
  type OutputsConfig,
} from './api';
import { addLinkCard } from './link-cards';

const PRESET_HINTS: Record<string, string> = {
  plan: 'Goals, scope, milestones, owners, risks',
  summary: 'Themes, insights, decisions, next steps',
  brief: 'Problem, users, requirements, metrics',
  notes: 'Topics, decisions, action items',
  overview: 'One slide per section or theme',
  pitch: 'Problem, solution, plan, the ask',
  status: 'Progress, next, risks, decisions needed',
  custom: 'Describe exactly what you want',
};

/** Starts generation as soon as the dialog opens (used by the AI panel's quick actions). */
export interface AutoStartRequest {
  key: number;
  elementIds: string[];
}

export function GenerateDialog({
  ctx,
  kind,
  open,
  onOpenChange,
  onCreated,
  autoStart,
}: {
  ctx: BoardContext;
  kind: DocKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (doc: BoardDocument) => void;
  autoStart?: AutoStartRequest | null;
}) {
  const [config, setConfig] = useState<OutputsConfig | null>(null);
  const [preset, setPreset] = useState<string>(kind === 'doc' ? 'plan' : 'overview');
  const [instructions, setInstructions] = useState('');
  const [scope, setScope] = useState<'board' | 'selection'>('board');
  const [selectionIds, setSelectionIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [doc, setDoc] = useState<BoardDocument | null>(null);
  const [paused, setPaused] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const startedKey = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreset(kind === 'doc' ? 'plan' : 'overview');
    setInstructions('');
    setError(null);
    setDoc(null);
    setPaused(null);
    const sel = autoStart ? autoStart.elementIds : selectedElements(ctx.excalidrawAPI).map((e) => e.id);
    setSelectionIds(sel);
    setScope(sel.length ? 'selection' : 'board');
    getOutputsConfig()
      .then((c) => {
        setConfig(c);
        if (c.paused) setPaused(c.pauseMessage ?? 'Monet AI is paused right now.');
      })
      .catch(() => setConfig(null));
  }, [open, kind, ctx.excalidrawAPI, autoStart]);

  // Quick action from the AI panel: write right away with the default kind of document.
  useEffect(() => {
    if (!open || !autoStart || startedKey.current === autoStart.key || !ctx.canEdit) return;
    startedKey.current = autoStart.key;
    void start({ preset: kind === 'doc' ? 'plan' : 'overview', elementIds: autoStart.elementIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoStart, ctx.canEdit, kind]);

  // Poll the new document until it's written.
  useEffect(() => {
    if (!doc || doc.status !== 'generating') return;
    pollRef.current = window.setTimeout(async () => {
      try {
        const d = await getDocument(ctx.boardId, doc.id, ctx.linkToken);
        setDoc(d.document);
      } catch (err) {
        setError(errorMessage(err));
      }
    }, 1500);
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [doc, ctx.boardId, ctx.linkToken]);

  // Once it's written, drop a link card for it on the board.
  const carded = useRef(new Set<string>());
  useEffect(() => {
    const api = ctx.excalidrawAPI;
    if (!doc || doc.status !== 'ready' || !api || !ctx.canEdit || carded.current.has(doc.id)) return;
    carded.current.add(doc.id);
    addLinkCard(api, { target: doc.kind, targetId: doc.id, url: doc.url, title: doc.title });
  }, [doc, ctx.excalidrawAPI, ctx.canEdit]);

  const presets = (kind === 'doc' ? config?.docPresets : config?.deckPresets) ?? [];
  const remaining = config ? Math.max(0, config.usage.requestLimit - config.usage.requestsUsed) : null;
  const noun = kind === 'doc' ? 'doc' : 'deck';

  async function start(args: { preset: string; instructions?: string; elementIds?: string[] }) {
    setError(null);
    setSubmitting(true);
    try {
      const res = await createDocument(
        ctx.boardId,
        { kind, preset: args.preset, instructions: args.instructions, elementIds: args.elementIds?.length ? args.elementIds : undefined },
        ctx.linkToken,
      );
      setDoc(res.document);
      onCreated?.(res.document);
    } catch (err) {
      if (isAiPausedError(err)) setPaused(err.message);
      else setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  function submit() {
    if (preset === 'custom' && !instructions.trim()) {
      setError('Describe what you want the AI to write.');
      return;
    }
    void start({
      preset,
      instructions: instructions.trim() || undefined,
      elementIds: scope === 'selection' && selectionIds.length ? selectionIds : undefined,
    });
  }

  const viewerHref = doc ? appPath(withLink(doc.url, ctx.linkToken)) : '#';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid={`dialog-generate-${kind}`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {kind === 'doc' ? <FileText className="h-5 w-5" /> : <Presentation className="h-5 w-5" />}
            Turn this board into a {noun}
          </DialogTitle>
          <DialogDescription>The AI reads the stickies, sections, and arrows and writes a {noun} you can read, share, and download.</DialogDescription>
        </DialogHeader>

        {!doc && autoStart && submitting ? (
          <div className="flex items-center gap-3 py-4 text-sm" data-testid="generate-starting">
            <Loader2 className="h-5 w-5 animate-spin text-primary" /> Starting…
          </div>
        ) : doc ? (
          <div className="py-4" data-testid="generate-progress">
            {doc.status === 'generating' && (
              <div className="flex items-center gap-3 text-sm">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <div>
                  <div className="font-medium">Writing your {noun}…</div>
                  <div className="text-muted-foreground">
                    This usually takes 20 to 60 seconds. You can close this; it'll show up in Docs &amp; decks and the AI chat.
                  </div>
                </div>
              </div>
            )}
            {doc.status === 'ready' && (
              <div className="rounded-lg border bg-muted/40 p-4">
                <div className="text-sm text-muted-foreground">Ready</div>
                <div className="mt-1 font-medium" data-testid="text-generated-title">
                  {doc.title}
                </div>
                <Button asChild className="mt-3" data-testid="button-open-generated">
                  <a href={viewerHref} target="_blank" rel="noreferrer">
                    Open {noun} <ExternalLink className="ml-1 h-4 w-4" />
                  </a>
                </Button>
              </div>
            )}
            {doc.status === 'error' && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-text">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                {doc.error ?? 'The AI could not finish this one.'}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {paused && (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
                data-testid="notice-outputs-ai-paused"
              >
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">AI paused</div>
                  <div className="text-amber-800">{paused} Exports and Send to still work.</div>
                </div>
              </div>
            )}
            {config && !config.ai && !paused && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                The board AI isn't configured on this server yet, so it can't write {noun}s.
              </div>
            )}
            <div>
              <Label className="mb-2 block">What should it write?</Label>
              <div className="grid grid-cols-2 gap-2">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPreset(p.id)}
                    className={cn(
                      'rounded-lg border p-3 text-left transition hover:bg-muted/60',
                      preset === p.id && 'border-primary ring-1 ring-primary bg-primary/5',
                    )}
                    data-testid={`preset-${p.id}`}
                  >
                    <div className="text-sm font-medium">{p.id === 'custom' ? 'Something else' : p.label}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{PRESET_HINTS[p.id]}</div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="gen-instructions" className="mb-2 block">
                {preset === 'custom' ? 'Describe it' : 'Anything to add? (optional)'}
              </Label>
              <Textarea
                id="gen-instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={kind === 'doc' ? 'e.g. Focus on the Q3 launch and keep it to one page' : 'e.g. 8 slides for the leadership review'}
                rows={3}
                maxLength={2000}
                data-testid="input-generate-instructions"
              />
            </div>
            <div>
              <Label className="mb-2 block">From</Label>
              <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'board' | 'selection')} className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="board" data-testid="radio-scope-board" /> The whole board
                </label>
                <label className={cn('flex items-center gap-2 text-sm', !selectionIds.length && 'opacity-50')}>
                  <RadioGroupItem value="selection" disabled={!selectionIds.length} data-testid="radio-scope-selection" />
                  The selection{selectionIds.length ? ` (${selectionIds.length} items)` : ''}
                </label>
              </RadioGroup>
            </div>
            {error && (
              <p className="text-sm text-destructive-text" data-testid="text-generate-error">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">{remaining !== null && !doc ? `${remaining} AI requests left today` : ''}</span>
          {doc ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <Button onClick={submit} disabled={submitting || !ctx.canEdit || config?.ai === false || !!paused} data-testid="button-generate-submit">
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
              Write {noun}
            </Button>
          )}
        </DialogFooter>
        {!ctx.canEdit && <p className="text-xs text-muted-foreground">You need edit access to ask the AI to write from this board.</p>}
      </DialogContent>
    </Dialog>
  );
}
