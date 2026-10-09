// The daily refresh's time of day (STATS_REFRESH_HOUR_UTC): read by the refresh job and by the stats freshness.

/** `hour`:00 UTC on `now`'s UTC day, or `days` days after it. */
export const refreshBoundary = (now: Date, hour: number, days = 0) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, hour));

/** The first refresh time after `now`; null when the refresh is off (`hour` undefined). */
export function nextRefresh(hour: number | undefined, now: Date): Date | null {
  if (hour === undefined) return null;
  const today = refreshBoundary(now, hour);
  return today > now ? today : refreshBoundary(now, hour, 1);
}
