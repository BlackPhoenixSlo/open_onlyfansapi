import { queryOptions } from '@tanstack/react-query';

type Schema = { example?: unknown; examples?: unknown[] };
type Parameter = { name: string; in: string };
type Operation = {
  tags?: string[];
  summary?: string;
  operationId?: string;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema; example?: unknown }> };
};
type Document = { paths?: Record<string, Record<string, Operation>> };

export type Op = {
  /** `GET /v1/{account}/users/me` */
  id: string;
  method: string;
  /** Path template, e.g. `/v1/{account}/users/{userId}/posts`. */
  path: string;
  tag: string;
  summary: string | undefined;
  /** Declared query parameter names. */
  query: string[];
  /** JSON body seed: the spec's example, `{}` without one, null when the operation takes no body. */
  body: string | null;
};

export type Spec = { ops: Op[]; backendAvailable: boolean };

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export const specQuery = queryOptions({
  queryKey: ['openapi'],
  queryFn: async (): Promise<Spec> => {
    const res = await fetch('/openapi.json');
    if (!res.ok) throw new Error(`Could not load the API spec (${res.status})`);
    return {
      ops: operations((await res.json()) as Document),
      backendAvailable: res.headers.get('x-backend-spec') !== 'unavailable',
    };
  },
  staleTime: 10 * 60_000,
});

function bodySeed(op: Operation): string | null {
  const json = op.requestBody?.content?.['application/json'];
  if (!json) return null;
  const example = json.example ?? json.schema?.example ?? json.schema?.examples?.[0];
  return example === undefined ? '{}' : JSON.stringify(example, null, 2);
}

function operations(doc: Document): Op[] {
  return Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.has(method))
      .map(([method, op]) => ({
        id: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        tag: op.tags?.[0] ?? 'other',
        summary: op.summary ?? op.operationId,
        query: (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name),
        body: bodySeed(op),
      })),
  );
}

export function groupByTag(ops: Op[]): [string, Op[]][] {
  const groups = new Map<string, Op[]>();
  for (const op of ops) groups.set(op.tag, [...(groups.get(op.tag) ?? []), op]);
  return [...groups];
}

const PARAM = /\{([^}]+)\}/g;

/** Path parameter names in a template, in order. */
export function pathParams(template: string): string[] {
  return [...template.matchAll(PARAM)].map((m) => m[1]!);
}

/** Fills `{name}` placeholders; empty ones stay as `{name}`. */
export function fillPath(template: string, values: Record<string, string>): string {
  return template.replace(PARAM, (whole, name: string) => (values[name] ? encodeURIComponent(values[name]) : whole));
}

/**
 * Why the playground must not send `url` (a path plus optional query), or null. The browser resolves `.`, `..`
 * and `%2e` segments before sending, so `/v1/%2e%2e/api/keys/x` would reach `/api/keys/x` with the session cookie
 * and pass the CSRF check. Only same-origin `/v1/` URLs without dot segments are sent.
 */
export function urlProblem(url: string, origin: string): string | null {
  const path = url.split('?')[0]!;
  if (!path.startsWith('/v1/')) return 'The path must start with /v1/.';
  let sent: URL;
  try {
    sent = new URL(url, origin);
  } catch {
    return 'The path is not a valid URL.';
  }
  const dotSegment = path.split(/[/\\]/).some((s) => /^(\.|%2e){1,2}$/i.test(s));
  if (dotSegment || sent.origin !== origin || !sent.pathname.startsWith('/v1/')) {
    return 'The path cannot contain . or .. segments.';
  }
  return null;
}

/** Segment-wise match of a raw path against a template; `literals` counts the non-placeholder segments. */
function matchTemplate(template: string, raw: string): { params: Record<string, string>; literals: number } | null {
  const t = template.split('/');
  const r = raw.split('/');
  if (t.length !== r.length) return null;
  const params: Record<string, string> = {};
  let literals = 0;
  for (let i = 0; i < t.length; i++) {
    const name = /^\{([^}]+)\}$/.exec(t[i]!)?.[1];
    if (name === undefined) {
      if (t[i] !== r[i]) return null;
      literals++;
    } else {
      if (r[i] === '') return null;
      params[name] = safeDecode(r[i]!);
    }
  }
  return { params, literals };
}

/**
 * Matches a raw path (`/v1/12/users/7/posts`) to an operation's template and extracts the path parameters.
 * When several templates match, the one with the most literal segments wins (`/users/me` over `/users/{id}`).
 */
export function matchPath(ops: Op[], method: string, raw: string): { op: Op; params: Record<string, string> } | undefined {
  let best: { op: Op; params: Record<string, string>; literals: number } | undefined;
  for (const op of ops) {
    const m = op.method === method ? matchTemplate(op.path, raw) : null;
    if (m && (!best || m.literals > best.literals)) best = { op, ...m };
  }
  return best && { op: best.op, params: best.params };
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
