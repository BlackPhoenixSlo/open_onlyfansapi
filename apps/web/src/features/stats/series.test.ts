import type { StatsMetricRow } from '@api/contracts';
import { describe, expect, it } from 'vitest';
import { addDays, combineAccounts, daysBetween, formatAgo, formatWait, formatWindow, liveLine, percent, sum, todayIn } from './series';

const row = (group: string, value: number | null, n: number, extra: Partial<StatsMetricRow> = {}): StatsMetricRow => ({
  group,
  value,
  n,
  pending: 0,
  ...extra,
});

describe('stats series helpers', () => {
  it('walks days across a month end, both ends included', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(daysBetween('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(daysBetween('2026-10-02', '2026-10-01')).toEqual([]);
  });

  it('formats today in a timezone as YYYY-MM-DD', () => {
    const now = new Date('2026-10-08T23:30:00Z');
    expect(todayIn('UTC', now)).toBe('2026-10-08');
    expect(todayIn('Europe/Ljubljana', now)).toBe('2026-10-09');
  });

  it('sums counts and treats missing ones as 0', () => {
    const rows = [row('a', 1, 2, { slaMet: 3 }), row('b', 1, 2)];
    expect(sum(rows, 'slaMet')).toBe(3);
    expect(sum(rows, 'n')).toBe(4);
    expect(percent(1, 4)).toBe(25);
    expect(percent(1, 0)).toBeNull();
  });

  it('is exact for one account and n-weighted for several', () => {
    expect(combineAccounts([row('1', 60, 10)])).toEqual({ value: 60, n: 10, exact: true });
    expect(combineAccounts([row('1', 60, 3), row('2', 120, 1), row('3', null, 0)])).toEqual({ value: 75, n: 4, exact: false });
    expect(combineAccounts([])).toEqual({ value: null, n: 0, exact: true });
  });

  it('formats waits and windows in plain words', () => {
    expect(formatWait(42)).toBe('42s');
    expect(formatWait(252)).toBe('4m 12s');
    expect(formatWait(7500)).toBe('2h 5m');
    expect(formatWait(900)).toBe('15m');
    expect(formatWait(7200)).toBe('2h');
    expect(formatWait(null)).toBe('—');
    expect(formatWindow(604_800)).toBe('7 days');
    expect(formatWindow(86_400)).toBe('24 h');
    expect(formatWindow(900)).toBe('15 min');
  });
});

describe('live line', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  it('formats how long ago', () => {
    expect(formatAgo('2026-10-08T11:59:30Z', now)).toBe('just now');
    expect(formatAgo('2026-10-08T12:00:30Z', now)).toBe('just now'); // clock skew
    expect(formatAgo('2026-10-08T11:55:00Z', now)).toBe('5m ago');
    expect(formatAgo('2026-10-08T09:00:00Z', now)).toBe('3h ago');
    expect(formatAgo('2026-10-05T12:00:00Z', now)).toBe('3d ago');
  });
  it('says when there is no event yet', () => {
    expect(liveLine({ lastLiveAt: null, lastBackfillAt: null, liveEvents24h: 0 }, now)).toBe('Live: no events yet');
    expect(liveLine({ lastLiveAt: '2026-10-08T11:55:00Z', lastBackfillAt: null, liveEvents24h: 4 }, now)).toBe(
      'Live: last message event 5m ago · 4 events last 24h',
    );
  });
});
