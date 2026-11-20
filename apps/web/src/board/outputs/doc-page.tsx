// /b/:id/docs/:docId — reads a generated doc: rendered Markdown with copy, .md, .docx, and print/PDF.
import { useEffect, useState } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Check, Copy, Download, FileText, Loader2, Printer, Trash2, TriangleAlert } from 'lucide-react';
import { LogoMark } from '@/components/logo';
import { safeHref } from '@/board/ai/markdown';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { deleteDocument, downloadUrl, errorMessage, getDocument, withLink, type BoardDocument } from './api';

export function useGeneratedDocument() {
  const { id, docId } = useParams<{ id: string; docId: string }>();
  const linkToken = new URLSearchParams(useSearch()).get('link');
  const [doc, setDoc] = useState<BoardDocument | null>(null);
  const [board, setBoard] = useState<{ id: string; title: string; role: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const load = async () => {
      try {
        const d = await getDocument(id!, docId!, linkToken);
        if (cancelled) return;
        setDoc(d.document);
        setBoard(d.board);
        if (d.document.status === 'generating') timer = window.setTimeout(load, 2000);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Couldn't open this."));
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [id, docId, linkToken]);

  useEffect(() => {
    if (doc?.title) document.title = `${doc.title} · Monet Blackboard`;
  }, [doc?.title]);

  return { boardId: id!, docId: docId!, linkToken, doc, board, error };
}

export function OutputStatus({ doc, error, noun }: { doc: BoardDocument | null; error: string | null; noun: string }) {
  if (error) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-6 text-center" data-testid="text-output-error">
        <div>
          <TriangleAlert className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }
  if (!doc || doc.status === 'generating') {
    return (
      <div className="grid min-h-[60vh] place-items-center text-center" data-testid="status-output-generating">
        <div>
          <Loader2 className="mx-auto h-7 w-7 animate-spin text-primary" />
          <p className="mt-3 text-sm text-muted-foreground">{doc ? `The AI is writing this ${noun}…` : 'Loading…'}</p>
        </div>
      </div>
    );
  }
  if (doc.status === 'error') {
    return (
      <div className="grid min-h-[60vh] place-items-center px-6 text-center">
        <div>
          <TriangleAlert className="mx-auto h-8 w-8 text-destructive-text" />
          <p className="mt-3 text-sm">{doc.error ?? `The AI couldn't write this ${noun}.`}</p>
        </div>
      </div>
    );
  }
  return null;
}

export function BackToBoard({ boardId, linkToken, title }: { boardId: string; linkToken: string | null; title?: string }) {
  return (
    <Link
      href={withLink(`/b/${boardId}`, linkToken)}
      className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      data-testid="link-back-to-board"
    >
      <ArrowLeft className="h-4 w-4 shrink-0" />
      <LogoMark className="h-5 w-5 shrink-0" />
      <span className="truncate">{title ?? 'Back to board'}</span>
    </Link>
  );
}

export default function DocPage() {
  const { boardId, linkToken, doc, board, error } = useGeneratedDocument();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [copied, setCopied] = useState(false);
  const ready = doc?.status === 'ready';
  const markdown = doc?.content?.markdown ?? '';
  const canEdit = board?.role === 'owner' || board?.role === 'editor';

  async function copy() {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    toast({ title: 'Markdown copied' });
    setTimeout(() => setCopied(false), 1500);
  }

  async function remove() {
    if (!doc || !window.confirm(`Delete "${doc.title}"? This can't be undone.`)) return;
    try {
      await deleteDocument(boardId, doc.id, linkToken);
      navigate(withLink(`/b/${boardId}`, linkToken));
    } catch (err) {
      toast({ title: "Couldn't delete", description: errorMessage(err), variant: 'destructive' });
    }
  }

  return (
    <div className="min-h-screen bg-muted/30 print:bg-white" data-testid="page-doc">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur print:hidden">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-3 px-4">
          <BackToBoard boardId={boardId} linkToken={linkToken} title={board?.title} />
          <div className="ml-auto flex items-center gap-2">
            {ready && (
              <>
                <Button variant="ghost" size="sm" onClick={() => void copy()} data-testid="button-copy-markdown">
                  {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />} Copy
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" data-testid="button-doc-download">
                      <Download className="mr-1 h-4 w-4" /> Download
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <a href={downloadUrl(doc!, 'docx', linkToken)} download data-testid="link-download-docx">
                        <FileText className="mr-2 h-4 w-4" /> Word (.docx)
                      </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <a href={downloadUrl(doc!, 'md', linkToken)} download data-testid="link-download-md">
                        <FileText className="mr-2 h-4 w-4" /> Markdown (.md)
                      </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => window.print()} data-testid="menu-print-doc">
                      <Printer className="mr-2 h-4 w-4" /> PDF (print)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {canEdit && (
                  <Button variant="ghost" size="icon" className="h-8 w-8" title="Delete" onClick={() => void remove()} data-testid="button-delete-doc">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </header>
      <OutputStatus doc={doc} error={error} noun="doc" />
      {ready && (
        <main className="mx-auto max-w-4xl px-4 py-8 print:p-0">
          <article
            className="prose prose-neutral max-w-none rounded-xl border bg-white px-6 py-8 shadow-sm sm:px-12 sm:py-12 print:border-0 print:shadow-none print:p-0 prose-headings:scroll-mt-20 prose-table:text-sm prose-th:bg-muted/60 prose-th:px-3 prose-td:px-3 prose-li:my-0.5"
            data-testid="doc-content"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node: _n, href, ...props }) => (
                  <a {...props} href={typeof href === 'string' ? (safeHref(href) ?? undefined) : undefined} target="_blank" rel="noreferrer" />
                ),
                // Images the AI wrote are links, never loaded: opening a doc must not contact other sites.
                img: ({ node: _n, src, alt }) => {
                  const href = typeof src === 'string' ? safeHref(src) : null;
                  return href ? (
                    <a href={href} target="_blank" rel="noreferrer">
                      {alt || 'image'}
                    </a>
                  ) : (
                    <span>{alt}</span>
                  );
                },
              }}
            >
              {markdown}
            </ReactMarkdown>
          </article>
          <p className="mt-4 text-center text-xs text-muted-foreground print:hidden">
            Written by Monet AI from the board{doc.createdByName ? ` for ${doc.createdByName}` : ''}. Check it before you share it.
          </p>
        </main>
      )}
    </div>
  );
}
