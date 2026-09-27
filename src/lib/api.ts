import { QueryClient, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

export async function http<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`/api${path}`, {
    ...rest,
    headers: json !== undefined ? { 'Content-Type': 'application/json', ...(rest.headers ?? {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
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
