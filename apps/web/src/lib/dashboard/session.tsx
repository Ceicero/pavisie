'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionUser } from '@pavisie/types';
import { apiFetch, ApiClientError, setCsrfToken } from './api';

interface MeResponse {
  user: SessionUser;
  csrfToken: string;
}

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface SessionContextValue {
  status: SessionStatus;
  user: SessionUser | null;
  csrfToken: string | null;
  /** Re-fetches `/auth/me`, e.g. after the user completes the Discord OAuth redirect. */
  refetch: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

/** Fetches and caches the authenticated dashboard user (`GET /auth/me`) and mirrors the CSRF token into `apiFetch`. */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery<MeResponse, ApiClientError>({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<MeResponse>('/auth/me'),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  React.useEffect(() => {
    setCsrfToken(query.data?.csrfToken ?? null);
  }, [query.data?.csrfToken]);

  const logout = React.useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      setCsrfToken(null);
      queryClient.setQueryData(['auth', 'me'], undefined);
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    }
  }, [queryClient]);

  const status: SessionStatus = query.isLoading
    ? 'loading'
    : query.data?.user
      ? 'authenticated'
      : 'unauthenticated';

  const value = React.useMemo<SessionContextValue>(
    () => ({
      status,
      user: query.data?.user ?? null,
      csrfToken: query.data?.csrfToken ?? null,
      refetch: query.refetch,
      logout,
    }),
    [status, query.data, query.refetch, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Reads the current dashboard session. Must be used within `SessionProvider` (mounted in the root layout). */
export function useSession(): SessionContextValue {
  const ctx = React.useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
