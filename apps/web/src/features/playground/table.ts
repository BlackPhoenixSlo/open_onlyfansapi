const LIST_KEYS = ['rows', 'items', 'data'] as const;
const MAX_ROWS = 100;

export type ResponseTable = { key: string; total: number; columns: string[]; rows: Record<string, unknown>[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{rows|items|data: [{…}, …]}` of flat objects as table data (first 100 rows), else null. */
export function responseTable(body: string): ResponseTable | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  for (const key of LIST_KEYS) {
    const list = parsed[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const flat = list.every((row) => isObject(row) && Object.values(row).every((v) => typeof v !== 'object' || v === null));
    if (!flat) return null;
    const rows = (list as Record<string, unknown>[]).slice(0, MAX_ROWS);
    return { key, total: list.length, columns: [...new Set(rows.flatMap((r) => Object.keys(r)))], rows };
  }
  return null;
}
