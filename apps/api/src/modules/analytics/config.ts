import { env } from '../../env.js';

const HOUR_MS = 3_600_000;

// The default reply cap (spec §4.5), used by the step 0 CSV export; the stats routes read the workspace's own from
// `stats_config`. Not baked in at ingest: it applies at query time.
export const REPLY_CAP_MS = 12 * HOUR_MS;

/** Backfill controls (spec §6.1). */
export type BackfillConfig = {
  /** Upstream requests per account in any rolling hour, counted within one run (one process): not across runs. */
  requestsPerHourPerAccount: number;
  /** Minimum gap from the end of one upstream response to the next request. */
  pageDelayMs: number;
  /** First 429 backoff without Retry-After; doubles per retry. */
  backoffBaseMs: number;
  /** Cap on any 429 wait, Retry-After included. */
  backoffMaxMs: number;
  /** Retries of one request after a 429; the next 429 (the 9th in a row by default) fails the run. */
  maxRetries: number;
  /** Waits before each retry of one request after a 502, 503, 504 or network error; once used up, the next fails the run. */
  transientDelaysMs: number[];
  /** Outbound texts the client's automations send (Infloww automations, bots): matches are `automation`. */
  automationTexts: string[];
};

export function backfillConfig(over: Partial<BackfillConfig> = {}): BackfillConfig {
  return {
    requestsPerHourPerAccount: env.ANALYTICS_REQUESTS_PER_HOUR,
    pageDelayMs: env.ANALYTICS_PAGE_DELAY_MS,
    backoffBaseMs: 1000,
    backoffMaxMs: env.ANALYTICS_BACKOFF_MAX_MS,
    maxRetries: 8,
    transientDelaysMs: [1000, 3000, 9000],
    automationTexts: [],
    ...over,
  };
}
