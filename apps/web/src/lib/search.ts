// Parsers for route search params: each returns the value when it is well formed, else undefined.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `v` when it is a `YYYY-MM-DD` day that exists (not 2026-02-30 or 2026-13-01), as the API's `parseDay` reads it. */
export function day(v: unknown): string | undefined {
  if (typeof v !== 'string' || !DAY.test(v)) return undefined;
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v ? v : undefined;
}

/** `v` when it is (a string of) a positive integer. */
export function positiveInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** `v` when it is a non-empty string. */
export const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
