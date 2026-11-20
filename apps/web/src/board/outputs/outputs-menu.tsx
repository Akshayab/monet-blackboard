// The board's outputs menu (top right): turn the board into a doc or deck, see generated docs & decks,
// export an image, and "Send to" other whiteboard tools.
import { useEffect, useState } from 'react';
import { exportToBlob } from '@excalidraw/excalidraw';
import { ChevronDown, Copy, FileText, Image as ImageIcon, Library, Link2, Presentation, Send, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import type { BoardContext } from '../slots';
import { errorMessage, selectedElements, type DocKind } from './api';
import { DocumentsDialog, useBoardDocuments } from './documents-dialog';
import { ExportImageDialog } from './export-image-dialog';
import { QUICK_ACTION_EVENT, type QuickActionEventDetail } from '../ai/quick-actions';
import { GenerateDialog, type AutoStartRequest } from './generate-dialog';
import { SendToDialog, type SendTarget } from './send-to-dialog';
import { LinkBoardDialog } from './link-board-dialog';

export function OutputsMenu({ ctx, compact }: { ctx: BoardContext; compact?: boolean }) {
  const { toast } = useToast();
  const [generate, setGenerate] = useState<DocKind | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [sendTo, setSendTo] = useState<SendTarget | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoStart, setAutoStart] = useState<AutoStartRequest | null>(null);
  const [linkBoardOpen, setLinkBoardOpen] = useState(false);

  // The AI panel's "Turn into doc / deck" quick actions hand off to this feature.
  useEffect(() => {
    const onQuickAction = (e: Event) => {
      const d = (e as CustomEvent<QuickActionEventDetail>).detail;
      if (e.defaultPrevented || !d || d.boardId !== ctx.boardId || (d.id !== 'doc' && d.id !== 'deck')) return;
      e.preventDefault();
      setAutoStart({ key: Date.now(), elementIds: d.focusElementIds ?? [] });
      setGenerate(d.id);
    };
    window.addEventListener(QUICK_ACTION_EVENT, onQuickAction);
    return () => window.removeEventListener(QUICK_ACTION_EVENT, onQuickAction);
  }, [ctx.boardId]);
  const { docs } = useBoardDocuments(ctx, menuOpen || docsOpen);
  const count = docs?.length ?? 0;

  async function copyPng() {
    const api = ctx.excalidrawAPI;
    if (!api) return;
    const sel = selectedElements(api);
    const elements = sel.length ? sel : api.getSceneElements();
    if (!elements.length) {
      toast({ title: 'Nothing to copy yet' });
      return;
    }
    try {
      const blob = exportToBlob({
        elements,
        files: api.getFiles(),
        appState: { exportBackground: true, viewBackgroundColor: api.getAppState().viewBackgroundColor },
        exportPadding: 24,
        getDimensions: (w: number, h: number) => ({ width: w * 2, height: h * 2, scale: 2 }),
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast({ title: sel.length ? 'Selection copied as an image' : 'Board copied as an image' });
    } catch (err) {
      toast({ title: "Couldn't copy", description: errorMessage(err, 'Your browser blocked clipboard access.'), variant: 'destructive' });
    }
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-9 gap-1 bg-white" data-testid="button-outputs-menu">
            <Share2 className="h-4 w-4" />
            {!compact && <span>Export</span>}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Turn this board into…</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => {
              setAutoStart(null);
              setGenerate('doc');
            }}
            disabled={!ctx.canEdit}
            data-testid="menu-turn-into-doc"
          >
            <FileText className="mr-2 h-4 w-4" /> A doc
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setAutoStart(null);
              setGenerate('deck');
            }}
            disabled={!ctx.canEdit}
            data-testid="menu-turn-into-deck"
          >
            <Presentation className="mr-2 h-4 w-4" /> A deck
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDocsOpen(true)} data-testid="menu-documents">
            <Library className="mr-2 h-4 w-4" /> Docs &amp; decks
            {count > 0 && <span className="ml-auto rounded-full bg-muted px-1.5 text-xs">{count}</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setLinkBoardOpen(true)} disabled={!ctx.canEdit} data-testid="menu-link-board">
            <Link2 className="mr-2 h-4 w-4" /> Link a board…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setImageOpen(true)} data-testid="menu-export-image">
            <ImageIcon className="mr-2 h-4 w-4" /> Export image (PNG, SVG)…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyPng()} data-testid="menu-copy-png">
            <Copy className="mr-2 h-4 w-4" /> Copy as image
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="menu-send-to">
              <Send className="mr-2 h-4 w-4" /> Send to
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => setSendTo('miro')} data-testid="menu-send-miro">
                Miro
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSendTo('lucid')} data-testid="menu-send-lucid">
                Lucid
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSendTo('drawio')} data-testid="menu-send-drawio">
                draw.io / diagrams.net
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSendTo('excalidraw')} data-testid="menu-send-excalidraw">
                Excalidraw
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      <GenerateDialog
        ctx={ctx}
        kind={generate ?? 'doc'}
        open={generate !== null}
        autoStart={autoStart}
        onOpenChange={(o) => {
          if (o) return;
          setGenerate(null);
          setAutoStart(null);
        }}
      />
      <DocumentsDialog
        ctx={ctx}
        open={docsOpen}
        onOpenChange={setDocsOpen}
        onNew={(k) => {
          setDocsOpen(false);
          setAutoStart(null);
          setGenerate(k);
        }}
      />
      <ExportImageDialog ctx={ctx} open={imageOpen} onOpenChange={setImageOpen} />
      <LinkBoardDialog ctx={ctx} open={linkBoardOpen} onOpenChange={setLinkBoardOpen} />
      <SendToDialog ctx={ctx} open={sendTo !== null} initialTarget={sendTo ?? 'miro'} onOpenChange={(o) => !o && setSendTo(null)} />
    </>
  );
}
