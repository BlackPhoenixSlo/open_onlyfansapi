import type { Account, ApiKey, ErrorBody, Whoami } from '@api/contracts';
import { queryOptions } from '@tanstack/react-query';

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
