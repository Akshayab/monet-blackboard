// /b/:id/decks/:docId — a slideshow for a generated deck: arrow keys, fullscreen, speaker notes,
// .pptx / .md download, and print-to-PDF (one slide per page).
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText, Maximize, Minimize, NotebookPen, Presentation, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { downloadUrl, type Slide } from './api';
import { BackToBoard, OutputStatus, useGeneratedDocument } from './doc-page';

function SlideView({ slide, index, className }: { slide: Slide; index: number; className?: string }) {
  const title = index === 0;
  return (
    <div className={cn('relative aspect-video w-full overflow-hidden bg-white text-[#1e1e1e]', className)} style={{ containerType: 'inline-size' }}>
      {title ? (
        <>
          <div className="absolute inset-y-0 left-0 w-[1.9cqw] bg-[#4c6ef5]" />
          <div className="absolute left-[7cqw] right-[7cqw] top-[31%]">
            <h1 className="text-[5cqw] font-bold leading-tight">{slide.title}</h1>
            {slide.bullets.length > 0 && <p className="mt-[2cqw] whitespace-pre-line text-[2.4cqw] text-[#5f6670]">{slide.bullets.join('\n')}</p>}
          </div>
        </>
      ) : (
        <div className="absolute inset-0 px-[5cqw] py-[4cqw]">
          <h2 className="text-[3.6cqw] font-bold leading-tight">{slide.title}</h2>
          <div className="mt-[1.2cqw] h-[0.45cqw] w-[7.5cqw] bg-[#4c6ef5]" />
          <ul className={cn('mt-[3cqw] list-disc space-y-[1.3cqw] pl-[3cqw]', slide.bullets.length > 5 ? 'text-[2.1cqw]' : 'text-[2.6cqw]')}>
            {slide.bullets.map((b, i) => (
              <li key={i} className="leading-snug">
                {b}
              </li>
            ))}
          </ul>
          <span className="absolute bottom-[2.5cqw] right-[3cqw] text-[1.3cqw] text-[#5f6670]">{index + 1}</span>
        </div>
      )}
    </div>
  );
}

export default function DeckPage() {
  const { boardId, linkToken, doc, board, error } = useGeneratedDocument();
  const slides = doc?.content?.slides ?? [];
  const [index, setIndex] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const ready = doc?.status === 'ready';

  const go = useCallback((d: number) => setIndex((i) => Math.max(0, Math.min(slides.length - 1, i + d))), [slides.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) {
        e.preventDefault();
        go(1);
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        go(-1);
      } else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(Math.max(0, slides.length - 1));
      else if (e.key === 'f' || e.key === 'F') void toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, slides.length]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    else await stageRef.current?.requestFullscreen().catch(() => undefined);
  }

  const current = slides[index];

  return (
    <div className="min-h-screen bg-muted/30 print:bg-white" data-testid="page-deck">
      <style>{`@media print { @page { size: 13.333in 7.5in; margin: 0; } .deck-print-slide { break-after: page; width: 100vw; } .deck-print-slide:last-child { break-after: auto; } }`}</style>
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur print:hidden">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <BackToBoard boardId={boardId} linkToken={linkToken} title={board?.title} />
          {ready && (
            <div className="ml-auto flex items-center gap-2">
              <Button variant={showNotes ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowNotes((s) => !s)} data-testid="button-toggle-notes">
                <NotebookPen className="mr-1 h-4 w-4" /> Notes
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void toggleFullscreen()} data-testid="button-present">
                <Presentation className="mr-1 h-4 w-4" /> Present
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" data-testid="button-deck-download">
                    <Download className="mr-1 h-4 w-4" /> Download
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <a href={downloadUrl(doc!, 'pptx', linkToken)} download data-testid="link-download-pptx">
                      <Presentation className="mr-2 h-4 w-4" /> PowerPoint (.pptx)
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href={downloadUrl(doc!, 'md', linkToken)} download>
                      <FileText className="mr-2 h-4 w-4" /> Outline (.md)
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => window.print()} data-testid="menu-print-deck">
                    <Printer className="mr-2 h-4 w-4" /> PDF (print)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </header>

      <OutputStatus doc={doc} error={error} noun="deck" />

      {ready && current && (
        <>
          <main className="mx-auto grid max-w-6xl gap-4 px-4 py-6 lg:grid-cols-[180px_1fr] print:hidden">
            <nav className="order-2 flex gap-2 overflow-x-auto lg:order-1 lg:max-h-[calc(100vh-7rem)] lg:flex-col lg:overflow-y-auto" aria-label="Slides">
              {slides.map((s, i) => (
                <button
                  key={i}
                  onClick={() => setIndex(i)}
                  className={cn(
                    'w-36 shrink-0 overflow-hidden rounded-md border-2 bg-white text-left lg:w-full',
                    i === index ? 'border-primary' : 'border-transparent hover:border-muted-foreground/30',
                  )}
                  data-testid={`thumb-slide-${i}`}
                >
                  <SlideView slide={s} index={i} className="pointer-events-none" />
                </button>
              ))}
            </nav>
            <div className="order-1 min-w-0 lg:order-2">
              <div
                ref={stageRef}
                className={cn('relative', fullscreen && 'grid place-items-center bg-black')}
                onClick={(e) => fullscreen && go(e.clientX > window.innerWidth / 2 ? 1 : -1)}
              >
                <SlideView
                  slide={current}
                  index={index}
                  className={cn(fullscreen ? 'max-h-screen w-auto max-w-full aspect-video h-screen' : 'rounded-lg shadow-md')}
                />
                {fullscreen && (
                  <button
                    className="absolute right-4 top-4 rounded bg-white/10 p-2 text-white"
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleFullscreen();
                    }}
                    title="Exit"
                  >
                    <Minimize className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <Button variant="outline" size="sm" onClick={() => go(-1)} disabled={index === 0} data-testid="button-prev-slide">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-muted-foreground" data-testid="text-slide-counter">
                  {index + 1} / {slides.length}
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => void toggleFullscreen()} title="Fullscreen (F)">
                    <Maximize className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => go(1)} disabled={index === slides.length - 1} data-testid="button-next-slide">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {showNotes && (
                <div className="mt-3 rounded-lg border bg-card p-4 text-sm text-card-foreground" data-testid="text-speaker-notes">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Speaker notes</div>
                  {current.notes || <span className="text-muted-foreground">No notes for this slide.</span>}
                </div>
              )}
              <p className="mt-3 text-xs text-muted-foreground">Use ← → to move between slides and F for fullscreen. Written by Monet AI from the board.</p>
            </div>
          </main>
          <div className="hidden print:block">
            {slides.map((s, i) => (
              <div key={i} className="deck-print-slide">
                <SlideView slide={s} index={i} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
