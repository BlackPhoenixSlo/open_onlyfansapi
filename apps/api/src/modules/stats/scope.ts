import { AppError } from '../../lib/errors.js';
import type { Actor } from '../../plugins/actor.js';

// Range and account scope shared by `GET /v1/stats` and the `/v1/stats/metrics`, `/v1/stats/scripts` routes.

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

/** The key's allowlist, narrowed by `accountId` (403 outside it); null = every account of the workspace. */
export function scopedAccounts(actor: Actor, accountId: number | undefined): number[] | null {
  const allowed = actor.accountIds;
  if (accountId !== undefined && allowed && !allowed.includes(accountId)) {
    throw new AppError(403, 'account_not_allowed', `This API key cannot use account ${accountId}`);
  }
  return accountId !== undefined ? [accountId] : allowed;
}
