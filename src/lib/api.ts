import { QueryClient, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

/**
 * Base URL of the API server. Empty when the frontend is served with /api proxied to the backend
 * (Vite dev server, Vercel/Netlify rewrites, or the backend serving the built app itself).
 * Set VITE_API_URL at build time to call a backend on another domain directly.
 */
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
export const apiUrl = (path: string) => `${API_BASE}/api${path}`;

/** Called when the server says the session is missing or expired. */
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function http<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(apiUrl(path), {
    credentials: 'include',
    ...rest,
    headers: json !== undefined ? { 'Content-Type': 'application/json', ...(rest.headers ?? {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401 && !path.startsWith('/session')) onUnauthorized?.();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export function qs(params: Record<string, string | number | null | undefined | boolean>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function useApi<T>(path: string | null, opts?: Partial<UseQueryOptions<T>>) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => http<T>(path!),
    enabled: !!path,
    ...opts,
  });
}

/** Mutation that invalidates everything afterwards (data is highly interlinked). */
export function useAction<TArgs, TRes = unknown>(fn: (args: TArgs) => Promise<TRes>, opts?: { onSuccess?: (r: TRes) => void }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      qc.invalidateQueries();
      opts?.onSuccess?.(r);
    },
  });
}
