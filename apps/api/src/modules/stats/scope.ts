import { AppError } from '../../lib/errors.js';
import type { Actor } from '../../plugins/actor.js';
import { zonedMidnight, zonedToday } from '../analytics/metrics.js';

// Range and account scope shared by `GET /v1/stats` and the `/v1/stats/metrics`, `/v1/stats/scripts`, `/v1/stats/revenue` routes.

export const DAY_MS = 86_400_000;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 366;

/** Midnight UTC of a `YYYY-MM-DD` day; 400 for a day that does not exist (e.g. 2026-02-30, 2026-13-01). */
export function parseDay(value: string, name: string): number {
  const t = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) {
    throw new AppError(400, 'validation_error', `\`${name}\` is not a valid YYYY-MM-DD day`);
  }
  return t;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Every day from `from` to `to` (`YYYY-MM-DD`), both included. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/** `value`; 400 for a day that does not exist (e.g. 2026-02-30, 2026-13-01). */
function checkDay(value: string, name: string): string {
  parseDay(value, name);
  return value;
}

/** `from`/`to` days in the config timezone (`to` inclusive), as the instants `[from, to)`. */
export function range(query: { from?: string; to?: string }, tz: string) {
  const to = query.to ? checkDay(query.to, 'to') : zonedToday(tz);
  const from = query.from ? checkDay(query.from, 'from') : addDays(to, -(DEFAULT_DAYS - 1));
  if (from > to) throw new AppError(400, 'invalid_range', '`from` must not be after `to`');
  if (addDays(from, MAX_DAYS - 1) < to) throw new AppError(400, 'range_too_large', `The range can span at most ${MAX_DAYS} days`);
  return { fromDay: from, toDay: to, from: zonedMidnight(from, tz), to: zonedMidnight(addDays(to, 1), tz) };
}

/** 403 when `accountId` is outside the key's allowlist. */
export function assertAccountAllowed(actor: Actor, accountId: number): void {
  if (actor.accountIds && !actor.accountIds.includes(accountId)) {
    throw new AppError(403, 'account_not_allowed', `This API key cannot use account ${accountId}`);
  }
}

/** The key's allowlist, narrowed by `accountId` (403 outside it); null = every account of the workspace. */
export function scopedAccounts(actor: Actor, accountId: number | undefined): number[] | null {
  if (accountId === undefined) return actor.accountIds;
  assertAccountAllowed(actor, accountId);
  return [accountId];
}
