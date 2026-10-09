import type {
  Account,
  ApiKey,
  DeliveryStatus,
  ErrorBody,
  GatewayEvent,
  LogDetail,
  LogList,
  LogStatus,
  Overview,
  ProxyInfo,
  StatsBackfillRun,
  StatsConfig,
  StatsFans,
  StatsFreshness,
  StatsGroupBy,
  StatsMetric,
  StatsMessages,
  StatsMetricSeries,
  StatsRevenue,
  StatsScripts,
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

/** The upstream's proxy registry with bound accounts and traffic stats (dashboard only; never credentials). */
export const proxiesQuery = queryOptions({
  queryKey: ['proxies'],
  queryFn: () => api<{ items: ProxyInfo[] }>('/api/proxies'),
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

/** The newest ledger events (`data: null`) for the Live events card; empty for an unlinked workspace. */
export const recentEventsQuery = queryOptions({
  queryKey: ['events', 'recent'],
  queryFn: () => api<{ events: GatewayEvent[] }>('/api/webhooks/stream/recent'),
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

export type StatsRange = { from?: string; to?: string; accountId?: number };

export const statsConfigQuery = queryOptions({
  queryKey: ['stats', 'config'],
  queryFn: () => api<{ config: StatsConfig; freshness: StatsFreshness }>('/v1/stats/config'),
});

export const statsMetricsQuery = queryOptions({
  queryKey: ['stats', 'metrics'],
  queryFn: () => api<{ items: StatsMetric[] }>('/v1/stats/metrics'),
  staleTime: Infinity,
});

/** The rows the metric CSV holds; `statsMetricPath(..., 'csv')` is the same request as `text/csv`. */
export const statsMetricPath = (id: string, params: StatsRange & { groupBy: StatsGroupBy }, format?: 'csv') =>
  `/v1/stats/metrics/${encodeURIComponent(id)}?${qs({ ...params, format })}`;

export const statsMetricQuery = (id: string, params: StatsRange & { groupBy: StatsGroupBy }) =>
  queryOptions({
    queryKey: ['stats', 'metric', id, params],
    queryFn: () => api<StatsMetricSeries>(statsMetricPath(id, params)),
  });

export const statsScriptsQuery = (params: StatsRange) =>
  queryOptions({
    queryKey: ['stats', 'scripts', params],
    queryFn: () => api<StatsScripts>(`/v1/stats/scripts?${qs(params)}`),
  });

/** The most fans `GET /v1/stats/fans` returns (contracts.ts `statsFansQuery`, `limit` `.max(1000)`). */
export const FAN_LIMIT = 1000;

/** `limit` defaults to the API's 200; `search` (username, name or chat id) is matched by the API. */
export const statsFansQuery = (params: StatsRange & { limit?: number; search?: string }) =>
  queryOptions({
    queryKey: ['stats', 'fans', params],
    queryFn: () => api<StatsFans>(`/v1/stats/fans?${qs(params)}`),
  });

export const statsRevenueQuery = (params: StatsRange) =>
  queryOptions({
    queryKey: ['stats', 'revenue', params],
    queryFn: () => api<StatsRevenue>(`/v1/stats/revenue?${qs(params)}`),
  });

/** The stored messages as CSV; `direction: 'in'` = the fans' messages only. */
export const statsMessagesCsvPath = (params: StatsRange & { chatId?: number; direction: 'in' | 'all' }) =>
  `/v1/stats/messages?${qs({ ...params, format: 'csv' })}`;

/** Rows per page when reading a whole conversation (contracts.ts `statsMessagesQuery`, `limit` `.max(5000)`). */
const CONVERSATION_PAGE = 5000;

/** The longest range a conversation is read over, in days (the API's `MAX_DAYS`, modules/stats/scope.ts). */
export const THREAD_DAYS = 366;

/** One fan's chat: `from`/`to` days (API defaults when absent), the account and the chat. */
export type ConversationParams = { from?: string; to?: string; accountId: number; chatId: number };

/** A whole conversation: the messages response without the paging fields. */
export type Conversation = Omit<StatsMessages, 'truncated' | 'nextCursor'>;

/**
 * One fan's messages in the range, oldest first: every page of `GET /v1/stats/messages` (`cursor` = `nextCursor`).
 * Not refetched on focus, which would re-run every page.
 */
export const statsConversationQuery = (params: ConversationParams) =>
  queryOptions({
    queryKey: ['stats', 'conversation', params],
    queryFn: async ({ signal }): Promise<Conversation> => {
      const items: StatsMessages['items'] = [];
      let cursor: string | undefined;
      for (;;) {
        const path = `/v1/stats/messages?${qs({ ...params, direction: 'all', limit: CONVERSATION_PAGE, cursor })}`;
        const { truncated: _truncated, nextCursor, ...page } = await api<StatsMessages>(path, { signal });
        items.push(...page.items);
        if (!nextCursor) return { ...page, items };
        cursor = nextCursor;
      }
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

/** The account's last analytics backfill run (`POST /v1/stats/backfill`), or `idle`. */
export const statsBackfillQuery = (accountId: number) =>
  queryOptions({
    queryKey: ['stats', 'backfill', accountId],
    queryFn: () => api<StatsBackfillRun>(`/v1/stats/backfill?${qs({ accountId })}`),
  });
