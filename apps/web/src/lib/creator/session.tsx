'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatorIdentityDto, CreatorMeDto } from '@pavisie/types/creator';
import { ApiClientError, API_BASE_URL } from '@/lib/dashboard/api';
import { creatorFetch, setCreatorCsrfToken } from './api';

export type CreatorSessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface CreatorSessionContextValue {
  status: CreatorSessionStatus;
  creator: CreatorIdentityDto | null;
  csrfToken: string | null;
  /** Where the "Sign in with Twitch" button goes (the API starts the OAuth flow). */
  loginUrl: string;
  logout: () => Promise<void>;
}

const CreatorSessionContext = React.createContext<CreatorSessionContextValue | null>(null);

export const CREATOR_ME_QUERY_KEY = ['creator', 'me'] as const;

/** URL that starts a creator sign-in for a platform. Twitch only today; Kick will add its own route. */
export function creatorLoginUrl(platform: 'twitch'): string {
  return `${API_BASE_URL}/creator/auth/${platform}/login`;
}

/**
 * Fetches and caches the signed-in creator (`GET /creator/me`) and mirrors their CSRF token into `creatorFetch`.
 * Deliberately separate from the Discord dashboard's `SessionProvider` (`lib/dashboard/session.tsx`): a creator
 * has no Discord account, and the two sessions must never share state. Mounted by `app/creator/layout.tsx`, so it
 * only exists (and only calls the API) on `/creator/**`.
 */
export function CreatorSessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery<CreatorMeDto, ApiClientError>({
    queryKey: CREATOR_ME_QUERY_KEY,
    queryFn: () => creatorFetch<CreatorMeDto>('/creator/me'),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  React.useEffect(() => {
    setCreatorCsrfToken(query.data?.csrfToken ?? null);
  }, [query.data?.csrfToken]);

  const logout = React.useCallback(async () => {
    try {
      await creatorFetch('/creator/logout', { method: 'POST' });
    } finally {
      setCreatorCsrfToken(null);
      // Drop everything creator-scoped so the next sign-in (possibly a different streamer) starts clean.
      queryClient.removeQueries({ queryKey: ['creator'] });
      await queryClient.invalidateQueries({ queryKey: CREATOR_ME_QUERY_KEY });
    }
  }, [queryClient]);

  const status: CreatorSessionStatus = query.isLoading
    ? 'loading'
    : query.data?.creator
      ? 'authenticated'
      : 'unauthenticated';

  const value = React.useMemo<CreatorSessionContextValue>(
    () => ({
      status,
      creator: query.data?.creator ?? null,
      csrfToken: query.data?.csrfToken ?? null,
      loginUrl: creatorLoginUrl('twitch'),
      logout,
    }),
    [status, query.data, logout],
  );

  return <CreatorSessionContext.Provider value={value}>{children}</CreatorSessionContext.Provider>;
}

/** Reads the current creator session. Must be used within `CreatorSessionProvider` (`app/creator/layout.tsx`). */
export function useCreatorSession(): CreatorSessionContextValue {
  const ctx = React.useContext(CreatorSessionContext);
  if (!ctx) throw new Error('useCreatorSession must be used within a CreatorSessionProvider');
  return ctx;
}
