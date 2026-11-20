import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Route, Switch, useLocation, useParams, Router as WouterRouter } from 'wouter';
import { Loader2 } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { LogoMark } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider, useAuth } from '@/hooks/use-auth';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import { api, ApiError } from '@/lib/api';

function FullPageSpinner() {
  return (
    <div className="min-h-screen grid place-items-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function Centered({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-screen w-full place-items-center bg-background px-6">
      <div className="w-full max-w-sm text-center">
        <LogoMark className="mx-auto h-12 w-12" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Team mode, no session in this browser: the owner needs the owner link; everyone else needs a board link. */
function NeedsLink() {
  return (
    <Centered title="Ask for a link">
      <p className="mt-2 text-sm text-muted-foreground" data-testid="text-needs-link">
        This Monet Blackboard is shared by its owner. Open a board link they sent you to join. If you run this server, open the owner link printed in its
        terminal.
      </p>
    </Centered>
  );
}

/** Renders children once someone is identified (always true in solo mode). */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (!user) return <NeedsLink />;
  return <>{children}</>;
}

/** /claim#<token>: the owner link (team mode). The token is in the fragment, so it never reaches server logs. */
function ClaimPage() {
  const { claim, mode, isLoading } = useAuth();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  // Pasting a corrected link over a failed one only changes the fragment, which doesn't reload the page.
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (isLoading) return;
    if (mode !== 'team') {
      navigate('/', { replace: true });
      return;
    }
    const token = hash.slice(1);
    if (token) setError(null);
    history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setError('This owner link is missing its code. Copy the full link from the server terminal.');
      return;
    }
    claim(token)
      .then(() => navigate('/', { replace: true }))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open the owner link.'));
  }, [claim, hash, isLoading, mode, navigate]);
  if (!error) return <FullPageSpinner />;
  return (
    <Centered title="Owner link didn't work">
      <p className="mt-2 text-sm text-muted-foreground" data-testid="text-claim-error">
        {error}
      </p>
    </Centered>
  );
}

/** /s/:token: a board's share link. In team mode, people new to this server enter a name first. */
function ShareLink() {
  const { token } = useParams<{ token: string }>();
  const { user, isLoading, joinAsGuest } = useAuth();
  const [, navigate] = useLocation();
  const [board, setBoard] = useState<{ boardId: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(() => localStorage.getItem('monet.guestName') ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ boardId: string; title: string }>(`/share/${token}`)
      .then(setBoard)
      .catch(() => setError("This link doesn't work anymore. Ask the owner for a new one."));
  }, [token]);

  useEffect(() => {
    if (user && board) navigate(`/b/${board.boardId}?link=${encodeURIComponent(token!)}`, { replace: true });
  }, [user, board, token, navigate]);

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      localStorage.setItem('monet.guestName', name.trim());
      await joinAsGuest(name.trim(), token!);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join. Try again.');
      setBusy(false);
    }
  }

  if (error) {
    return (
      <Centered title="Can't open this board">
        <p className="mt-2 text-sm text-muted-foreground" data-testid="text-share-error">
          {error}
        </p>
      </Centered>
    );
  }
  if (isLoading || !board || user) return <FullPageSpinner />;
  return (
    <Centered title={board.title}>
      <p className="mt-2 text-sm text-muted-foreground">You've been invited to this board. What should people call you?</p>
      <form onSubmit={onJoin} className="mt-6 flex flex-col gap-3 text-left">
        <label htmlFor="guest-name" className="text-sm font-medium">
          Your name
        </label>
        <Input
          id="guest-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoFocus
          placeholder="e.g. Sam"
          data-testid="input-guest-name"
        />
        <Button type="submit" disabled={!name.trim() || busy} data-testid="button-join-board">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Join board'}
        </Button>
      </form>
    </Centered>
  );
}

// The board page pulls in Excalidraw; load it (and the doc and deck pages) only when one is opened.
const BoardPage = lazy(() => import('@/pages/board'));
const DocPage = lazy(() => import('@/board/outputs/doc-page'));
const DeckPage = lazy(() => import('@/board/outputs/deck-page'));

function PageLoading() {
  return (
    <div className="grid min-h-screen place-items-center" data-testid="page-loading">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Suspense fallback={<PageLoading />}>
        <Switch>
          <Route path="/">
            <RequireAuth>
              <Home />
            </RequireAuth>
          </Route>
          <Route path="/claim" component={ClaimPage} />
          <Route path="/b/:id/docs/:docId">
            <RequireAuth>
              <DocPage />
            </RequireAuth>
          </Route>
          <Route path="/b/:id/decks/:docId">
            <RequireAuth>
              <DeckPage />
            </RequireAuth>
          </Route>
          <Route path="/b/:id">
            <RequireAuth>
              <BoardPage />
            </RequireAuth>
          </Route>
          <Route path="/s/:token" component={ShareLink} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <TooltipProvider>
      <AuthProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
      </AuthProvider>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
