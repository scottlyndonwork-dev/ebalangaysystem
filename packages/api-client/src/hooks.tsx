import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RequestOtpInput, VerifyOtpInput } from '@ebalangay/shared';
import { createContext, type ReactNode, useContext } from 'react';
import type { ApiClient } from './client.js';
import { queryKeys } from './query-keys.js';

const ApiClientContext = createContext<ApiClient | null>(null);

/** Provide one client per app; put it inside QueryClientProvider. */
export function ApiClientProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}) {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error('useApiClient must be used inside <ApiClientProvider>');
  return client;
}

export function useHealth() {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.health(),
    queryFn: ({ signal }) => api.health.get(signal),
    staleTime: 30_000,
  });
}

export function useMe(options: { enabled?: boolean } = {}) {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.me(),
    queryFn: ({ signal }) => api.auth.me(signal),
    staleTime: 5 * 60_000,
    enabled: options.enabled ?? true,
  });
}

export function useRequestOtp() {
  const api = useApiClient();
  return useMutation({ mutationFn: (input: RequestOtpInput) => api.auth.requestOtp(input) });
}

/** On success the caller stores `tokens` (secure store on mobile); the user is cached here. */
export function useVerifyOtp() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: VerifyOtpInput) => api.auth.verifyOtp(input),
    onSuccess: (res) => qc.setQueryData(queryKeys.me(), res.user),
  });
}

export function useLogout() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (refreshToken?: string) => api.auth.logout(refreshToken ? { refreshToken } : {}),
    // Clear every cached query, even if the server call failed.
    onSettled: () => qc.removeQueries({ queryKey: queryKeys.all }),
  });
}
