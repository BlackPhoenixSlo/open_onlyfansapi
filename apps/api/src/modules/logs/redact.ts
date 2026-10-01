import type { IncomingHttpHeaders } from 'node:http';

/** JSON keys and query parameters whose values are never stored. */
export const SENSITIVE_KEY = /pass(word)?|secret|token|cookie|auth|otp|session|code$|(api|access|private)[-_]?key|credential/i;
export const MASK = '[redacted]';

/** Never stored, even if added to the allow-list below. */
const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-internal-key']);
/** Request headers kept in a log row; everything else is left out. */
const LOGGED_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'content-length',
  'content-type',
  'origin',
  'user-agent',
  'x-dashboard',
  'x-of-cache',
]);

export function redactHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_HEADERS.has(name) || !LOGGED_HEADERS.has(name)) continue;
    out[name] = SENSITIVE_KEY.test(name) ? MASK : Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** `a=1&token=x` → `a=1&token=[redacted]`. Takes and returns the query without the leading `?`; '' → null. */
export function redactQuery(query: string): string | null {
  if (!query) return null;
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // keep the raw key
      }
      return SENSITIVE_KEY.test(key) ? `${rawKey}=${MASK}` : pair;
    })
    .join('&');
}

function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? MASK : maskJson(v)]),
  );
}

/**
 * Body as stored in a log row: JSON keeps its shape with sensitive values masked, anything else becomes
 * `[<n> bytes <type>]`. Redaction runs before truncation, so a cut never exposes a value it would have masked.
 */
export function redactBody(body: string | Buffer | null | undefined, contentType: string | undefined, maxBytes: number): string | null {
  if (body === null || body === undefined || body.length === 0) return null;
  let text: string;
  if (contentType && /json/i.test(contentType)) {
    try {
      text = JSON.stringify(maskJson(JSON.parse(body.toString())));
    } catch {
      text = placeholder(body, contentType);
    }
  } else {
    text = placeholder(body, contentType);
  }
  return truncate(text, maxBytes);
}

function placeholder(body: string | Buffer, contentType: string | undefined): string {
  return `[${Buffer.byteLength(body)} bytes ${contentType?.split(';')[0]?.trim() || 'unknown'}]`;
}

function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text);
  return buf.length <= maxBytes ? text : `${buf.subarray(0, maxBytes).toString()}…[truncated]`;
}
