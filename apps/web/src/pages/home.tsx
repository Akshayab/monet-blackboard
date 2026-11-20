import { boardTitleFromPrompt } from '@monet/board-protocol';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { AlertCircle, LayoutGrid, List, LogOut, Pencil, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import { Logo } from '@/components/logo';
import { UsageMeter } from '@/components/usage-meter';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { BoardGridView, BoardListView, BoardSkeletons, EmptyState, type BoardActions } from '@/components/library/board-views';
import { StartNew, type CreatingKind } from '@/components/library/start-new';
import { usePersistedState } from '@/components/library/use-persisted-state';
import { isTypingTarget } from '@/components/shortcuts/registry';
import type { TemplateId } from '@/components/templates/templates';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { api, ApiError, userName, type BoardSummary } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PENDING_PROMPT_KEY } from '@/lib/pending-prompt';

type Filter = 'all' | 'mine' | 'shared';
type Sort = 'recent' | 'name';
type View = 'grid' | 'list';

const FILTERS: Filter[] = ['all', 'mine', 'shared'];
const SORTS: Sort[] = ['recent', 'name'];
const VIEWS: View[] = ['grid', 'list'];

function errorMessage(err: unknown) {
  return err instanceof ApiError ? err.message : 'Check your connection and try again.';
}

export default function Home() {
  const { user, mode, ai, logout, rename } = useAuth();
  const isGuest = user?.kind === 'guest';
  const [nameDialog, setNameDialog] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState<CreatingKind>(null);
  const [renaming, setRenaming] = useState<BoardSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<BoardSummary | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = usePersistedState<Filter>('monet:library-filter', 'all', FILTERS);
  const [sort, setSort] = usePersistedState<Sort>('monet:library-sort', 'recent', SORTS);
  const [view, setView] = usePersistedState<View>('monet:library-view', 'grid', VIEWS);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api<{ boards: BoardSummary[] }>('/boards');
      setBoards(data.boards);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // /s/:token links that no longer work land here with ?share=invalid.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('share') === 'invalid') {
      toast({ title: "That share link doesn't work anymore", description: 'Ask the board owner for a new link.', variant: 'destructive' });
      navigate('/', { replace: true });
    }
  }, [navigate, toast]);

  // "/" jumps to search.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function createBoard(kind: Exclude<CreatingKind, null>, initialPrompt?: string) {
    setCreating(kind);
    try {
      const json =
        kind === 'blank' ? { title: 'Untitled board' } : kind === 'prompt' ? { title: boardTitleFromPrompt(initialPrompt!) } : { template: kind as TemplateId };
      const { board } = await api<{ board: BoardSummary }>('/boards', { method: 'POST', json });
      if (initialPrompt) sessionStorage.setItem(PENDING_PROMPT_KEY, JSON.stringify({ boardId: board.id, prompt: initialPrompt }));
      navigate(`/b/${board.id}`);
    } catch (err) {
      toast({ title: "Couldn't create the board", description: errorMessage(err), variant: 'destructive' });
      setCreating(null);
    }
  }

  function onPromptSubmit(e: FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || creating) return;
    void createBoard('prompt', prompt.trim());
  }

  const actions: BoardActions = {
    onRename: (b) => {
      setRenaming(b);
      setRenameValue(b.title);
    },
    onDuplicate: async (b) => {
      try {
        const { board } = await api<{ board: BoardSummary }>(`/boards/${b.id}/duplicate`, { method: 'POST' });
        setBoards((prev) => (prev ? [board, ...prev] : [board]));
        toast({ title: 'Board duplicated', description: board.title });
      } catch (err) {
        toast({ title: "Couldn't duplicate the board", description: errorMessage(err), variant: 'destructive' });
      }
    },
    onDelete: (b) => setDeleting(b),
  };

  async function confirmDelete() {
    const b = deleting;
    if (!b) return;
    setDeleting(null);
    try {
      await api(`/boards/${b.id}`, { method: 'DELETE' });
      setBoards((prev) => prev?.filter((x) => x.id !== b.id) ?? null);
      toast({ title: b.role === 'owner' ? 'Board deleted' : 'You left the board', description: b.title });
    } catch (err) {
      toast({ title: b.role === 'owner' ? "Couldn't delete the board" : "Couldn't leave the board", description: errorMessage(err), variant: 'destructive' });
    }
  }

  async function saveRename() {
    const b = renaming;
    const title = renameValue.trim();
    if (!b || !title) return;
    try {
      await api(`/boards/${b.id}`, { method: 'PATCH', json: { title } });
      setBoards((prev) => prev?.map((x) => (x.id === b.id ? { ...x, title } : x)) ?? null);
      setRenaming(null);
    } catch (err) {
      toast({ title: "Couldn't rename the board", description: errorMessage(err), variant: 'destructive' });
    }
  }

  const counts = useMemo(() => {
    const all = boards ?? [];
    const mine = all.filter((b) => b.role === 'owner').length;
    return { all: all.length, mine, shared: all.length - mine };
  }, [boards]);

  const visible = useMemo(() => {
    if (!boards) return [];
    const q = query.trim().toLowerCase();
    const tab = mode === 'team' ? filter : 'all';
    const list = boards.filter((b) => {
      if (tab === 'mine' && b.role !== 'owner') return false;
      if (tab === 'shared' && b.role === 'owner') return false;
      if (!q) return true;
      return b.title.toLowerCase().includes(q) || (b.ownerName ?? '').toLowerCase().includes(q);
    });
    return list.sort((a, b) =>
      sort === 'name'
        ? a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
        : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [boards, filter, mode, query, sort]);

  function renderBoards() {
    if (loadError) {
      return (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center"
          data-testid="status-library-error"
        >
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive-text" aria-hidden="true" />
          <div className="flex-1">
            <p className="font-medium">Couldn't load your boards</p>
            <p className="text-sm text-muted-foreground">{loadError}</p>
          </div>
          <Button variant="outline" onClick={() => void load()} className="gap-2" data-testid="button-library-retry">
            <RefreshCw className="h-4 w-4" /> Try again
          </Button>
        </div>
      );
    }
    if (boards === null) return <BoardSkeletons view={view} />;
    if (visible.length === 0) {
      if (query.trim()) {
        return (
          <EmptyState
            testId="empty-search"
            title={`No boards match "${query.trim()}"`}
            body="Try another word, or search all boards instead of one tab."
            action={
              <Button variant="outline" onClick={() => setQuery('')}>
                Clear search
              </Button>
            }
          />
        );
      }
      if (mode === 'team' && filter === 'shared') {
        return <EmptyState testId="empty-shared" title="Nothing shared with you yet" body="Boards you open through a share link show up here." />;
      }
      if (isGuest) return <EmptyState testId="empty-library" title="No boards yet" body="Open a board link from the owner to see it here." />;
      return (
        <EmptyState
          testId="empty-library"
          title="Your boards will live here"
          body="Start a blank whiteboard, pick a template, or describe what you want to think through and let the AI lay it out."
          action={
            <Button onClick={() => void createBoard('blank')} disabled={creating !== null}>
              New whiteboard
            </Button>
          }
        />
      );
    }
    return view === 'grid' ? <BoardGridView boards={visible} actions={actions} /> : <BoardListView boards={visible} actions={actions} />;
  }

  const filterLabel: Record<Filter, string> = { all: 'All boards', mine: 'Yours', shared: 'Shared with you' };

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#library"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to your boards
      </a>
      <header className="sticky top-0 z-30 border-b bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Logo />
          <div className="flex items-center gap-2">
            <UsageMeter />
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-2" aria-label={`Menu for ${userName(user)}`} data-testid="button-user-menu">
                  <span className="grid h-7 w-7 place-items-center overflow-hidden rounded-full bg-primary/15 text-sm font-semibold text-primary-text">
                    {userName(user).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="hidden text-sm sm:inline">{userName(user)}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="truncate text-sm font-medium">{userName(user)}</div>
                  <div className="truncate text-xs text-muted-foreground" data-testid="text-server-mode">
                    {mode === 'team' ? (user?.kind === 'owner' ? 'Owner · team mode' : 'Guest') : 'Solo mode'}
                  </div>
                  {ai.model && (
                    <div className="truncate text-xs text-muted-foreground" data-testid="text-ai-model">
                      AI: {ai.model}
                    </div>
                  )}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    setNameValue(userName(user));
                    setNameDialog(true);
                  }}
                  data-testid="button-rename-me"
                >
                  <Pencil className="mr-2 h-4 w-4" /> Change your name
                </DropdownMenuItem>
                {mode === 'team' && (
                  <DropdownMenuItem onSelect={() => void logout().then(() => navigate('/'))} data-testid="button-logout">
                    <LogOut className="mr-2 h-4 w-4" /> Leave on this browser
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {isGuest ? (
          <section className="max-w-3xl" aria-labelledby="prompt-title">
            <h1 id="prompt-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Boards shared with you
            </h1>
            <p className="mt-1 text-muted-foreground">Open a board to work on it with everyone else who's there.</p>
          </section>
        ) : (
          <section className="max-w-3xl" aria-labelledby="prompt-title">
            <h1 id="prompt-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
              What do you want to think through?
            </h1>
            <p className="mt-1 text-muted-foreground">Describe a plan, a decision, a process, or a retro. The AI lays it out on a new board.</p>
            <form onSubmit={onPromptSubmit} className="mt-5 rounded-xl border bg-card p-3 shadow-sm focus-within:ring-2 focus-within:ring-ring">
              <label htmlFor="home-prompt" className="sr-only">
                Describe what you want to think through
              </label>
              <Textarea
                id="home-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) onPromptSubmit(e);
                }}
                placeholder="e.g. Start a whiteboard to plan our product launch in March: beta, pricing, press, and the launch event"
                className="min-h-[88px] resize-none border-0 text-base shadow-none focus-visible:ring-0"
                data-testid="input-home-prompt"
              />
              <div className="flex items-center justify-between gap-3 pt-2">
                <span className="hidden text-xs text-muted-foreground sm:inline">Enter to start · Shift+Enter for a new line</span>
                <Button type="submit" disabled={creating !== null || !prompt.trim()} className="ml-auto gap-2" data-testid="button-home-prompt">
                  <Sparkles className="h-4 w-4" /> Start board
                </Button>
              </div>
            </form>
          </section>
        )}

        {!isGuest && <StartNew creating={creating} onBlank={() => void createBoard('blank')} onTemplate={(id) => void createBoard(id)} />}

        <section id="library" className="mt-12 scroll-mt-20" aria-labelledby="library-title">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <h2 id="library-title" className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Library
            </h2>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setQuery('');
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Search boards"
                  aria-label="Search boards"
                  aria-keyshortcuts="/"
                  className="h-9 pl-8 pr-14 [&::-webkit-search-cancel-button]:hidden"
                  data-testid="input-library-search"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <kbd className="pointer-events-none absolute right-2 top-1/2 hidden h-5 -translate-y-1/2 items-center rounded border bg-muted px-1.5 font-sans text-[11px] text-muted-foreground sm:inline-flex">
                    /
                  </kbd>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                  <SelectTrigger className="h-9 w-full sm:w-[150px]" aria-label="Sort boards" data-testid="select-library-sort">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recent">Last edited</SelectItem>
                    <SelectItem value="name">Name (A–Z)</SelectItem>
                  </SelectContent>
                </Select>
                <ToggleGroup
                  type="single"
                  value={view}
                  onValueChange={(v) => v && setView(v as View)}
                  aria-label="Layout"
                  className="shrink-0 rounded-md border p-0.5"
                >
                  <ToggleGroupItem value="grid" aria-label="Grid view" className="h-7 w-8 px-0" data-testid="toggle-view-grid">
                    <LayoutGrid className="h-4 w-4" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="list" aria-label="List view" className="h-7 w-8 px-0" data-testid="toggle-view-list">
                    <List className="h-4 w-4" />
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>
          </div>

          {mode === 'team' && (
            <div role="tablist" aria-label="Which boards" className="mt-4 flex gap-1 overflow-x-auto border-b">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  id={`library-tab-${f}`}
                  aria-selected={filter === f}
                  aria-controls="library-panel"
                  onClick={() => setFilter(f)}
                  className={cn(
                    '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    filter === f ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                  data-testid={`tab-library-${f}`}
                >
                  {filterLabel[f]}
                  {boards && <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{counts[f]}</span>}
                </button>
              ))}
            </div>
          )}

          <div id="library-panel" role="tabpanel" aria-labelledby={`library-tab-${filter}`} aria-busy={boards === null} className="mt-4">
            {renderBoards()}
          </div>
        </section>
      </main>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename board</DialogTitle>
            <DialogDescription className="sr-only">Give this board a new name.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveRename();
            }}
            className="space-y-4"
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              maxLength={200}
              aria-label="Board name"
              data-testid="input-rename"
            />
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renameValue.trim()} data-testid="button-rename-save">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={nameDialog} onOpenChange={setNameDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your name</DialogTitle>
            <DialogDescription>Shown next to your cursor and in the AI chat.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!nameValue.trim()) return;
              void rename(nameValue.trim())
                .then(() => setNameDialog(false))
                .catch((err) => toast({ title: "Couldn't save your name", description: errorMessage(err), variant: 'destructive' }));
            }}
            className="space-y-4"
          >
            <Input
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              autoFocus
              maxLength={80}
              aria-label="Your name"
              data-testid="input-my-name"
            />
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => setNameDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!nameValue.trim()} data-testid="button-my-name-save">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleting?.role === 'owner' ? 'Delete this board?' : 'Leave this board?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.role === 'owner'
                ? `"${deleting?.title}" will be deleted for everyone it's shared with. This can't be undone.`
                : `"${deleting?.title}" will be removed from your library. You can come back if someone shares it again.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleting?.role === 'owner' ? 'Delete' : 'Leave'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
