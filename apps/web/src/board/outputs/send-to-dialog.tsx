// "Send to" other whiteboard tools: Miro (creates a real board with the user's token), Lucid (.lucid
// import file, or direct import with a Lucid API key), draw.io (.drawio), and Excalidraw (.excalidraw).
import { useEffect, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, Info, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { BoardContext } from '../slots';
import { downloadExport, errorMessage, selectedElements, type ExportFormat } from './api';

export type SendTarget = 'miro' | 'lucid' | 'drawio' | 'excalidraw';

interface SendResult {
  url: string;
  counts: Record<string, number>;
  skipped: Record<string, number> | string[];
  failed?: number;
}

function summarize(counts: Record<string, number>) {
  return Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
}

function Limits({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ResultCard({ result, label }: { result: SendResult; label: string }) {
  const skipped = Array.isArray(result.skipped) ? result.skipped : Object.entries(result.skipped).map(([k, v]) => `${v} ${k}`);
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm" data-testid="send-result">
      <div className="flex items-center gap-2 font-medium text-emerald-800">
        <CheckCircle2 className="h-4 w-4" /> Created in {label}
      </div>
      <p className="mt-1 text-emerald-900/80">{summarize(result.counts) || 'Board created.'}</p>
      {skipped.length > 0 && <p className="mt-1 text-xs text-emerald-900/70">Not sent: {skipped.join(', ')}.</p>}
      {!!result.failed && <p className="mt-1 text-xs text-[var(--monet-warn)]">{result.failed} items failed to create.</p>}
      <Button asChild size="sm" className="mt-2" data-testid="link-send-result">
        <a href={result.url} target="_blank" rel="noreferrer">
          Open in {label} <ExternalLink className="ml-1 h-3.5 w-3.5" />
        </a>
      </Button>
    </div>
  );
}

export function SendToDialog({
  ctx,
  open,
  onOpenChange,
  initialTarget = 'miro',
}: {
  ctx: BoardContext;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialTarget?: SendTarget;
}) {
  const { toast } = useToast();
  const [target, setTarget] = useState<SendTarget>(initialTarget);
  const [scope, setScope] = useState<'board' | 'selection'>('board');
  const [selectionIds, setSelectionIds] = useState<string[]>([]);
  const [miroToken, setMiroToken] = useState('');
  const [lucidToken, setLucidToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ target: SendTarget; data: SendResult } | null>(null);

  useEffect(() => {
    if (!open) return;
    setTarget(initialTarget);
    setError(null);
    setResult(null);
    const sel = selectedElements(ctx.excalidrawAPI).map((e) => e.id);
    setSelectionIds(sel);
    setScope(sel.length ? 'selection' : 'board');
  }, [open, initialTarget, ctx.excalidrawAPI]);

  // Never keep tokens around after the dialog closes.
  useEffect(() => {
    if (!open) {
      setMiroToken('');
      setLucidToken('');
    }
  }, [open]);

  const elementIds = scope === 'selection' && selectionIds.length ? selectionIds : undefined;
  const background = ctx.excalidrawAPI?.getAppState().viewBackgroundColor;

  async function download(format: ExportFormat) {
    setBusy(format);
    setError(null);
    try {
      const r = await downloadExport(ctx.boardId, format, { elementIds, linkToken: ctx.linkToken, background });
      toast({ title: `Saved ${r.filename}`, description: r.counts ? summarize(r.counts) : undefined });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function sendMiro() {
    setBusy('miro');
    setError(null);
    setResult(null);
    try {
      const r = await api<{ boardUrl: string; counts: Record<string, number>; skipped: Record<string, number>; failed: number }>(
        `/boards/${ctx.boardId}/send/miro`,
        { method: 'POST', json: { accessToken: miroToken.trim(), elementIds }, linkToken: ctx.linkToken },
      );
      setResult({ target: 'miro', data: { url: r.boardUrl, counts: r.counts, skipped: r.skipped, failed: r.failed } });
      setMiroToken('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function sendLucid() {
    setBusy('lucid-api');
    setError(null);
    setResult(null);
    try {
      const r = await api<{ editUrl: string | null; viewUrl: string | null; counts: Record<string, number>; skipped: string[] }>(
        `/boards/${ctx.boardId}/send/lucid`,
        { method: 'POST', json: { accessToken: lucidToken.trim(), elementIds, product: 'lucidspark' }, linkToken: ctx.linkToken },
      );
      setResult({ target: 'lucid', data: { url: r.editUrl ?? r.viewUrl ?? 'https://lucid.app/documents', counts: r.counts, skipped: r.skipped } });
      setLucidToken('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto" data-testid="dialog-send-to">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" /> Send to
          </DialogTitle>
          <DialogDescription>Open this board as an editable document in another whiteboard or diagram tool.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">Send</span>
          <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'board' | 'selection')} className="flex gap-4">
            <label className="flex items-center gap-2">
              <RadioGroupItem value="board" /> Whole board
            </label>
            <label className={cn('flex items-center gap-2', !selectionIds.length && 'opacity-50')}>
              <RadioGroupItem value="selection" disabled={!selectionIds.length} data-testid="radio-send-selection" /> Selection
              {selectionIds.length ? ` (${selectionIds.length})` : ''}
            </label>
          </RadioGroup>
        </div>

        <Tabs
          value={target}
          onValueChange={(v) => {
            setTarget(v as SendTarget);
            setError(null);
            setResult(null);
          }}
        >
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="miro" data-testid="tab-send-miro">
              Miro
            </TabsTrigger>
            <TabsTrigger value="lucid" data-testid="tab-send-lucid">
              Lucid
            </TabsTrigger>
            <TabsTrigger value="drawio" data-testid="tab-send-drawio">
              draw.io
            </TabsTrigger>
            <TabsTrigger value="excalidraw" data-testid="tab-send-excalidraw">
              Excalidraw
            </TabsTrigger>
          </TabsList>

          <TabsContent value="miro" className="space-y-3 pt-2">
            <p className="text-sm">Creates a new Miro board in your account with editable sticky notes, shapes, text, frames, and connectors.</p>
            <div className="space-y-1.5">
              <Label htmlFor="miro-token">Miro access token</Label>
              <Input
                id="miro-token"
                type="password"
                autoComplete="off"
                value={miroToken}
                onChange={(e) => setMiroToken(e.target.value)}
                placeholder="Paste a token with the boards:write scope"
                data-testid="input-miro-token"
              />
              <p className="text-xs text-muted-foreground">Used once to create the board, then discarded. Monet Blackboard never stores it.</p>
            </div>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">How do I get a token?</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>
                  In Miro, open{' '}
                  <a className="underline" href="https://miro.com/app/settings/user-profile/apps" target="_blank" rel="noreferrer">
                    Settings › Your apps
                  </a>{' '}
                  and create a new app (any name).
                </li>
                <li>
                  Under permissions, tick <code>boards:read</code> and <code>boards:write</code>.
                </li>
                <li>
                  Click <em>Install app and get OAuth token</em>, pick your team, and copy the token.
                </li>
              </ol>
              <a
                className="mt-1 inline-block underline"
                href="https://developers.miro.com/docs/rest-api-build-your-first-hello-world-app"
                target="_blank"
                rel="noreferrer"
              >
                Miro's guide
              </a>
            </details>
            <Limits>
              <p>Freehand drawings and arrows that aren't attached to two items aren't sent: Miro's API only creates connectors between items.</p>
              <p>Sticky colors snap to Miro's sticky palette; fonts and the hand-drawn look use Miro defaults.</p>
            </Limits>
            {result?.target === 'miro' && <ResultCard result={result.data} label="Miro" />}
            <Button onClick={() => void sendMiro()} disabled={miroToken.trim().length < 10 || !!busy} data-testid="button-send-miro">
              {busy === 'miro' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />} Create Miro board
            </Button>
          </TabsContent>

          <TabsContent value="lucid" className="space-y-3 pt-2">
            <p className="text-sm">
              Download a Lucid Standard Import file (<code>.lucid</code>) with sticky notes, shapes, containers for sections, text, images, and connected lines.
            </p>
            <Button variant="outline" onClick={() => void download('lucid')} disabled={!!busy} data-testid="button-download-lucid">
              {busy === 'lucid' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />} Download .lucid
            </Button>
            <Limits>
              <p>
                Lucid imports <code>.lucid</code> files through its API, not the in-app Import menu. Use a Lucid API key with the <code>DocumentEdit</code>{' '}
                grant below, or hand the file to your Lucid admin.{' '}
                <a className="underline" href="https://developer.lucid.co/docs/overview-si" target="_blank" rel="noreferrer">
                  About Lucid Standard Import
                </a>
              </p>
              <p>
                No key? Send the board to Miro first, then use Lucidspark's{' '}
                <a
                  className="underline"
                  href="https://help.lucid.co/hc/en-us/articles/15178812313492-Import-files-into-Lucidspark"
                  target="_blank"
                  rel="noreferrer"
                >
                  Import from Miro
                </a>
                .
              </p>
            </Limits>
            <div className="space-y-1.5 rounded-lg border p-3">
              <Label htmlFor="lucid-token">Create it in Lucidspark directly (optional)</Label>
              <Input
                id="lucid-token"
                type="password"
                autoComplete="off"
                value={lucidToken}
                onChange={(e) => setLucidToken(e.target.value)}
                placeholder="Lucid API key or OAuth token"
                data-testid="input-lucid-token"
              />
              <p className="text-xs text-muted-foreground">Used once for this import and never stored.</p>
              {result?.target === 'lucid' && <ResultCard result={result.data} label="Lucid" />}
              <Button size="sm" onClick={() => void sendLucid()} disabled={lucidToken.trim().length < 10 || !!busy} data-testid="button-send-lucid">
                {busy === 'lucid-api' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />} Create in Lucidspark
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="drawio" className="space-y-3 pt-2">
            <p className="text-sm">
              Download a <code>.drawio</code> file that opens in draw.io / diagrams.net, Confluence, and VS Code. Shapes stay editable and arrows stay
              connected.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void download('drawio')} disabled={!!busy} data-testid="button-download-drawio">
                {busy === 'drawio' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />} Download .drawio
              </Button>
              <Button asChild variant="ghost">
                <a href="https://app.diagrams.net/" target="_blank" rel="noreferrer">
                  Open diagrams.net <ExternalLink className="ml-1 h-3.5 w-3.5" />
                </a>
              </Button>
            </div>
            <Limits>
              <p>In diagrams.net, choose File › Open from › Device and pick the file.</p>
              <p>Sections become containers; freehand drawings become simple curves; the hand-drawn style isn't kept.</p>
            </Limits>
          </TabsContent>

          <TabsContent value="excalidraw" className="space-y-3 pt-2">
            <p className="text-sm">
              Download an <code>.excalidraw</code> file: an exact, fully editable copy of the board, including images.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void download('excalidraw')} disabled={!!busy} data-testid="button-download-excalidraw">
                {busy === 'excalidraw' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />} Download .excalidraw
              </Button>
              <Button asChild variant="ghost">
                <a href="https://excalidraw.com/" target="_blank" rel="noreferrer">
                  Open excalidraw.com <ExternalLink className="ml-1 h-3.5 w-3.5" />
                </a>
              </Button>
            </div>
            <Limits>
              <p>On excalidraw.com, open the menu › Open and pick the file. Collaborators and the AI chat stay here.</p>
            </Limits>
          </TabsContent>
        </Tabs>

        {error && (
          <p className="text-sm text-destructive-text" data-testid="text-send-error">
            {error}
          </p>
        )}
        <p className="text-xs text-muted-foreground">Other tools: export a PNG or SVG from the same menu, or use the draw.io file, which many tools import.</p>
      </DialogContent>
    </Dialog>
  );
}
