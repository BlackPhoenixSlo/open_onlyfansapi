import { queryOptions } from '@tanstack/react-query';

type Schema = {
  $ref?: string;
  type?: string;
  format?: string;
  pattern?: string;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  minimum?: number;
  maximum?: number;
  description?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
};
type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: Schema };
type Operation = {
  tags?: string[];
  summary?: string;
  operationId?: string;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema; example?: unknown }> };
};
type Document = { paths?: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, Schema> } };

/** A declared path or query parameter, or a JSON body property, as the form shows it. */
export type Param = {
  name: string;
  in: 'path' | 'query' | 'body';
  required: boolean;
  /** Short type hint: `integer 1–50`, `recent | old`, `string date`. */
  type: string;
  description: string | undefined;
  /** The spec's example or default, as text; undefined when it has neither (or the default is empty). */
  placeholder: string | undefined;
  /** `date` for ISO dates (`format: date` or a `YYYY-MM-DD` pattern), `date-time` for timestamps. */
  format: 'date' | 'date-time' | undefined;
  maximum: number | undefined;
};

export type Op = {
  /** `GET /v1/{account}/me` */
  id: string;
  method: string;
  /** Path template, e.g. `/v1/{account}/users/{userId}/posts`. */
  path: string;
  tag: string;
  summary: string | undefined;
  operationId: string | undefined;
  /** Declared path and query parameters (not `account`): path ones first, then required, then optional query ones. */
  params: Param[];
  /** JSON body properties, required first; empty without a body schema. */
  fields: Param[];
  /** JSON body seed: the spec's example, else a skeleton of the required properties; null when the operation takes no body. */
  body: string | null;
};

export type Spec = { ops: Op[]; upstreamAvailable: boolean };

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export const specQuery = queryOptions({
  queryKey: ['openapi'],
  queryFn: async (): Promise<Spec> => {
    const res = await fetch('/openapi.json');
    if (!res.ok) throw new Error(`Could not load the API spec (${res.status})`);
    return {
      ops: operations((await res.json()) as Document),
      upstreamAvailable: res.headers.get('x-upstream-spec') !== 'unavailable',
    };
  },
  staleTime: 10 * 60_000,
});

/** Follows `$ref`s into `components.schemas`. */
function deref(schema: Schema | undefined, schemas: Record<string, Schema>, depth = 0): Schema {
  if (!schema) return {};
  const name = schema.$ref?.replace('#/components/schemas/', '');
  if (name === undefined || depth > 8) return schema;
  return deref(schemas[name], schemas, depth + 1);
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const ISO_DATE = String.raw`^\d{4}-\d{2}-\d{2}$`;

function typeHint(schema: Schema): string {
  if (schema.enum) return schema.enum.map(String).join(' | ');
  if (schema.type === 'array') return `array of ${schema.items?.type ?? 'any'}`;
  const max = schema.maximum !== undefined && schema.maximum < Number.MAX_SAFE_INTEGER ? schema.maximum : undefined;
  const range = max === undefined ? '' : schema.minimum !== undefined ? ` ${schema.minimum}–${max}` : ` ≤ ${max}`;
  const format = schema.format ?? dateFormat(schema);
  return `${schema.type ?? 'any'}${format ? ` ${format}` : ''}${range}`;
}

function dateFormat(schema: Schema): Param['format'] {
  if (schema.format === 'date-time') return 'date-time';
  if (schema.format === 'date' || schema.pattern === ISO_DATE) return 'date';
  return undefined;
}

function param(name: string, where: Param['in'], required: boolean, schema: Schema, description?: string, example?: unknown): Param {
  return {
    name,
    in: where,
    required,
    type: typeHint(schema),
    description: description ?? schema.description,
    placeholder: text(example ?? schema.example ?? schema.examples?.[0] ?? schema.default),
    format: dateFormat(schema),
    maximum: schema.maximum,
  };
}

function zero(schema: Schema): unknown {
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '';
  }
}

function bodySeed(json: { schema?: Schema; example?: unknown } | undefined, schema: Schema): string | null {
  if (!json) return null;
  const example = json.example ?? schema.example ?? schema.examples?.[0];
  if (example !== undefined) return JSON.stringify(example, null, 2);
  const props = schema.properties ?? {};
  const skeleton = Object.fromEntries((schema.required ?? []).filter((n) => props[n]).map((n) => [n, zero(props[n]!)]));
  return JSON.stringify(skeleton, null, 2);
}

const RANK = (p: Param) => (p.in === 'path' ? 0 : p.required ? 1 : 2);

export function operations(doc: Document): Op[] {
  const schemas = doc.components?.schemas ?? {};
  return Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.has(method))
      .map(([method, op]) => {
        const json = op.requestBody?.content?.['application/json'];
        const bodySchema = deref(json?.schema, schemas);
        const required = new Set(bodySchema.required ?? []);
        return {
          id: `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          tag: op.tags?.[0] ?? 'other',
          summary: op.summary,
          operationId: op.operationId,
          params: (op.parameters ?? [])
            .filter((p) => (p.in === 'path' || p.in === 'query') && p.name !== 'account')
            .map((p) =>
              param(p.name, p.in as 'path' | 'query', p.in === 'path' || p.required === true, deref(p.schema, schemas), p.description, p.example),
            )
            .sort((a, b) => RANK(a) - RANK(b)),
          fields: Object.entries(bodySchema.properties ?? {})
            .map(([name, s]) => param(name, 'body', required.has(name), deref(s, schemas)))
            .sort((a, b) => Number(b.required) - Number(a.required)),
          body: bodySeed(json, bodySchema),
        };
      }),
  );
}

/** The sidebar group: the tag, with platform operations split by first path segment (`platform / chats`). */
export function groupOf(op: Op): string {
  if (op.tag !== 'platform') return op.tag;
  return `platform / ${op.path.split('/')[3] ?? ''}`;
}

/** A sidebar group; `collapsed` = closed until toggled (the platform sub-groups). */
export type OpGroup = { label: string; ops: Op[]; collapsed: boolean };

/** Operations by `groupOf`, in first-seen order. */
export function groupOps(ops: Op[]): OpGroup[] {
  const groups = new Map<string, OpGroup>();
  for (const op of ops) {
    const label = groupOf(op);
    const group = groups.get(label);
    if (group) group.ops.push(op);
    else groups.set(label, { label, ops: [op], collapsed: op.tag === 'platform' });
  }
  return [...groups.values()];
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
 * When several templates match, the one with the most literal segments wins (`/users/list` over `/users/{username}`).
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
