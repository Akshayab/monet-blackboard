import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type AuthUser } from '@/lib/api';

export type ServerMode = 'solo' | 'team';

interface AuthState {
  /** The owner in solo mode; in team mode, whoever this browser's session belongs to (or null). */
  user: AuthUser | null;
  mode: ServerMode;
  ai: { configured: boolean; model: string | null };
  /** Team mode: whether guests can ask the AI. */
  guestAi: boolean;
  isLoading: boolean;
  refresh: () => Promise<void>;
  /** Team mode: turn the owner link's token into an owner session in this browser. */
  claim: (token: string) => Promise<AuthUser>;
  /** Team mode: join through a share link with a name. */
  joinAsGuest: (name: string, linkToken: string) => Promise<{ user: AuthUser; boardId: string }>;
  rename: (name: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  setUser: (u: AuthUser | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

interface AuthResponse {
  user: AuthUser | null;
  mode: ServerMode;
  ai: { configured: boolean; model: string | null };
  guestAi: boolean;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [mode, setMode] = useState<ServerMode>('solo');
  const [ai, setAi] = useState<AuthState['ai']>({ configured: false, model: null });
  const [guestAi, setGuestAi] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api<AuthResponse>('/auth/user');
      setUser(data.user);
      setMode(data.mode);
      setAi(data.ai);
      setGuestAi(data.guestAi);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claim = useCallback(
    async (token: string) => {
      const data = await api<{ user: AuthUser }>('/auth/claim', { method: 'POST', json: { token } });
      setUser(data.user);
      await refresh();
      return data.user;
    },
    [refresh],
  );

  const joinAsGuest = useCallback(async (name: string, linkToken: string) => {
    const data = await api<{ user: AuthUser; boardId: string }>('/auth/guest', { method: 'POST', json: { name, linkToken } });
    setUser(data.user);
    return data;
  }, []);

  const rename = useCallback(async (name: string) => {
    const data = await api<{ user: AuthUser }>('/auth/user', { method: 'PATCH', json: { name } });
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, mode, ai, guestAi, isLoading, refresh, claim, joinAsGuest, rename, logout, setUser }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
