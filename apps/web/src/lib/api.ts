import type {
  Account,
  ApiKey,
  ErrorBody,
  LogDetail,
  LogList,
  LogStatus,
  Overview,
  Usage,
  UsageGroupBy,
  Whoami,
} from '@api/contracts';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Init = Omit<RequestInit, 'body'> & { body?: unknown };

export async function api<T>(path: string, init: Init = {}): Promise<T> {
  const { body, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('x-dashboard', '1');
  if (body !== undefined) headers.set('content-type', 'application/json');

  const res = await fetch(path, {
    ...rest,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ErrorBody | null;
    throw new ApiError(err?.error?.code ?? 'http_error', err?.error?.message ?? res.statusText, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const keysQuery = queryOptions({
  queryKey: ['keys'],
  queryFn: () => api<{ items: ApiKey[] }>('/api/keys'),
});

export const accountsQuery = queryOptions({
  queryKey: ['accounts'],
  queryFn: () => api<{ items: Account[] }>('/v1/accounts'),
});

export const whoamiQuery = queryOptions({
  queryKey: ['whoami'],
  queryFn: () => api<Whoami>('/v1/whoami'),
});

/** Builds a query string, skipping empty values. */
function qs(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') search.set(k, String(v));
  return search.toString();
}

export type LogFilters = {
  status?: LogStatus;
  keyId?: string;
  accountId?: number;
  method?: string;
  endpoint?: string;
  q?: string;
  from?: string;
  to?: string;
};

export const logsQuery = (filters: LogFilters) =>
  infiniteQueryOptions({
    queryKey: ['logs', filters],
    queryFn: ({ pageParam }) => api<LogList>(`/api/logs?${qs({ ...filters, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const logQuery = (id: string) =>
  queryOptions({
    queryKey: ['logs', 'detail', id],
    queryFn: () => api<LogDetail>(`/api/logs/${encodeURIComponent(id)}`),
  });

export const usageQuery = (params: { from: string; to: string; groupBy: UsageGroupBy }) =>
  queryOptions({
    queryKey: ['usage', params],
    queryFn: () => api<Usage>(`/api/usage?${qs(params)}`),
  });

export const overviewQuery = queryOptions({
  queryKey: ['overview'],
  queryFn: () => api<Overview>('/api/overview'),
});
