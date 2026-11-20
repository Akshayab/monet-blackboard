// Export > PNG / SVG / copy to clipboard, for the whole board or the selection, with background and scale.
import { useEffect, useMemo, useRef, useState } from 'react';
import { exportToBlob, exportToSvg } from '@excalidraw/excalidraw';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { Copy, Download, Image as ImageIcon, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import type { BoardContext } from '../slots';
import { errorMessage, saveBlob, selectedElements } from './api';

type Format = 'png' | 'svg';

function fileStem(title: string) {
  return (
    title
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'board'
  );
}

export function ExportImageDialog({ ctx, open, onOpenChange }: { ctx: BoardContext; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const [format, setFormat] = useState<Format>('png');
  const [scope, setScope] = useState<'board' | 'selection'>('board');
  const [background, setBackground] = useState(true);
  const [dark, setDark] = useState(false);
  const [scale, setScale] = useState(2);
  const [selection, setSelection] = useState<NonDeletedExcalidrawElement[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'download' | 'copy'>(null);
  const previewUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const sel = selectedElements(ctx.excalidrawAPI);
    setSelection(sel);
    setScope(sel.length ? 'selection' : 'board');
  }, [open, ctx.excalidrawAPI]);

  const elements = useMemo(() => {
    if (!open || !ctx.excalidrawAPI) return [];
    return scope === 'selection' && selection.length ? selection : ctx.excalidrawAPI.getSceneElements();
  }, [open, scope, selection, ctx.excalidrawAPI]);

  const viewBackgroundColor = ctx.excalidrawAPI?.getAppState().viewBackgroundColor ?? '#ffffff';
  const appState = useMemo(
    () => ({ exportBackground: background, viewBackgroundColor, exportWithDarkMode: dark, exportEmbedScene: false }),
    [background, viewBackgroundColor, dark],
  );

  // Live preview (small PNG).
  useEffect(() => {
    if (!open || !ctx.excalidrawAPI || !elements.length) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    exportToBlob({ elements, files: ctx.excalidrawAPI.getFiles(), appState, maxWidthOrHeight: 560, exportPadding: 16 })
      .then((blob: Blob) => {
        if (cancelled) return;
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = URL.createObjectURL(blob);
        setPreview(previewUrl.current);
      })
      .catch(() => setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [open, elements, appState, ctx.excalidrawAPI]);

  async function render(fmt: Format): Promise<Blob> {
    const files = ctx.excalidrawAPI!.getFiles();
    if (fmt === 'svg') {
      const svg = await exportToSvg({ elements, files, appState: { ...appState, exportScale: scale }, exportPadding: 24 });
      return new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    }
    return exportToBlob({
      elements,
      files,
      appState,
      exportPadding: 24,
      mimeType: 'image/png',
      getDimensions: (w: number, h: number) => ({ width: Math.round(w * scale), height: Math.round(h * scale), scale }),
    });
  }

  const stem = `${fileStem(ctx.board?.title || ctx.collab.title || 'board')}${scope === 'selection' ? '-selection' : ''}`;

  async function download() {
    setBusy('download');
    try {
      saveBlob(await render(format), `${stem}.${format}`);
      toast({ title: `Saved ${stem}.${format}` });
    } catch (err) {
      toast({ title: 'Export failed', description: errorMessage(err), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    setBusy('copy');
    try {
      if (format === 'svg') {
        const blob = await render('svg');
        await navigator.clipboard.writeText(await blob.text());
        toast({ title: 'SVG copied to the clipboard' });
      } else {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': render('png') })]);
        toast({ title: 'Image copied to the clipboard' });
      }
    } catch (err) {
      toast({ title: "Couldn't copy", description: errorMessage(err, 'Your browser blocked clipboard access.'), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="dialog-export-image">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="h-5 w-5" /> Export image
          </DialogTitle>
          <DialogDescription>Save the board as a PNG or SVG, or copy it to paste into a doc or chat.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 sm:grid-cols-[1fr_220px]">
          <div
            className={cn(
              'grid min-h-[220px] place-items-center rounded-lg border',
              background ? '' : 'bg-[conic-gradient(#f1f3f5_25%,#fff_0_50%,#f1f3f5_0_75%,#fff_0)] bg-[length:16px_16px]',
            )}
            data-testid="export-preview"
          >
            {preview ? (
              <img src={preview} alt="Export preview" className="max-h-[320px] max-w-full object-contain p-2" />
            ) : (
              <span className="text-sm text-muted-foreground">{elements.length ? 'Rendering…' : 'Nothing to export yet'}</span>
            )}
          </div>
          <div className="space-y-4">
            <div>
              <Label className="mb-2 block">Format</Label>
              <RadioGroup value={format} onValueChange={(v) => setFormat(v as Format)} className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="png" data-testid="radio-format-png" /> PNG
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="svg" data-testid="radio-format-svg" /> SVG
                </label>
              </RadioGroup>
            </div>
            <div>
              <Label className="mb-2 block">Area</Label>
              <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'board' | 'selection')} className="space-y-1">
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="board" /> Whole board
                </label>
                <label className={cn('flex items-center gap-2 text-sm', !selection.length && 'opacity-50')}>
                  <RadioGroupItem value="selection" disabled={!selection.length} data-testid="radio-export-selection" /> Selection
                  {selection.length ? ` (${selection.length})` : ''}
                </label>
              </RadioGroup>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="export-bg">Background</Label>
              <Switch id="export-bg" checked={background} onCheckedChange={setBackground} data-testid="switch-export-background" />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="export-dark">Dark mode</Label>
              <Switch id="export-dark" checked={dark} onCheckedChange={setDark} />
            </div>
            <div>
              <Label className="mb-2 block">Scale</Label>
              <div className="flex gap-1">
                {[1, 2, 3].map((s) => (
                  <Button
                    key={s}
                    type="button"
                    size="sm"
                    variant={scale === s ? 'default' : 'outline'}
                    onClick={() => setScale(s)}
                    data-testid={`button-scale-${s}`}
                  >
                    {s}×
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => void copy()} disabled={!elements.length || !!busy} data-testid="button-export-copy">
            {busy === 'copy' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Copy className="mr-2 h-4 w-4" />} Copy
          </Button>
          <Button onClick={() => void download()} disabled={!elements.length || !!busy} data-testid="button-export-download">
            {busy === 'download' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />} Download {format.toUpperCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
