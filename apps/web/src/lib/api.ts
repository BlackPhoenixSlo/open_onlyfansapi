import type {
  Account,
  ApiKey,
  DeliveryStatus,
  ErrorBody,
  LogDetail,
  LogList,
  LogStatus,
  Overview,
  Usage,
  UsageGroupBy,
  WebhookDeliveryList,
  WebhookEndpoint,
  WebhookEventInfo,
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

const FIELD_NAMES: Record<string, string> = { url: 'URL', id: 'ID' };

/** `/url Invalid URL; /events/0 Invalid option` (the API's validation_error message) → `URL: Invalid URL; Events 0: Invalid option`. */
export function formatValidationError(detail: string) {
  return detail
    .split('; ')
    .map((part) => {
      const m = /^\/(\S*) ([\s\S]*)$/.exec(part);
      if (!m) return part;
      const [, path = '', message = ''] = m;
      if (!path) return message;
      const [field = '', ...rest] = path.split('/');
      const name = FIELD_NAMES[field] ?? field.charAt(0).toUpperCase() + field.slice(1);
      return `${[name, ...rest].join(' ')}: ${message}`;
    })
    .join('; ');
}

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
    const code = err?.error?.code ?? 'http_error';
    const message = err?.error?.message ?? res.statusText;
    throw new ApiError(code, code === 'validation_error' ? formatValidationError(message) : message, res.status);
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

export const webhooksQuery = queryOptions({
  queryKey: ['webhooks'],
  queryFn: () => api<{ items: WebhookEndpoint[] }>('/v1/webhooks'),
});

export const webhookQuery = (id: string) =>
  queryOptions({
    queryKey: ['webhooks', 'detail', id],
    queryFn: () => api<{ endpoint: WebhookEndpoint }>(`/v1/webhooks/${encodeURIComponent(id)}`),
  });

export const webhookEventsQuery = queryOptions({
  queryKey: ['webhooks', 'events'],
  queryFn: () => api<{ items: WebhookEventInfo[] }>('/v1/webhooks/events'),
  staleTime: Infinity,
});

export type DeliveryFilters = { status?: DeliveryStatus; event?: string };

export const webhookDeliveriesQuery = (id: string, filters: DeliveryFilters) =>
  infiniteQueryOptions({
    queryKey: ['webhooks', 'deliveries', id, filters],
    queryFn: ({ pageParam }) =>
      api<WebhookDeliveryList>(`/v1/webhooks/${encodeURIComponent(id)}/deliveries?${qs({ ...filters, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
