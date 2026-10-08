import type { StatsMetricRow } from '@api/contracts';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  combineAccounts,
  daysBetween,
  formatAgo,
  formatWait,
  formatWindow,
  hourSeries,
  liveLine,
  openerSeries,
  percent,
  replySeries,
  slaSeries,
  sum,
  todayIn,
} from './series';

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

describe('chart series', () => {
  const span = ['2026-10-01', '2026-10-02', '2026-10-03'];
  it('fills every day of the span, null for a missing value', () => {
    expect(replySeries(span, [row('2026-10-01', 60, 2), row('2026-10-03', 30, 1)], [row('2026-10-01', 300, 2)])).toEqual([
      { day: '2026-10-01', median: 60, p90: 300 },
      { day: '2026-10-02', median: null, p90: null },
      { day: '2026-10-03', median: 30, p90: null },
    ]);
    expect(slaSeries(span, [row('2026-10-02', 80, 5)])).toEqual([
      { day: '2026-10-01', sla: null },
      { day: '2026-10-02', sla: 80 },
      { day: '2026-10-03', sla: null },
    ]);
    expect(slaSeries([], [row('2026-10-02', 80, 5)])).toEqual([]);
  });
  it('fills opener counts with 0 and drops rows outside the span', () => {
    const rows = [row('2026-10-02', null, 4, { replied: 2, noReply: 1, pending: 1 }), row('2026-09-30', null, 9, { replied: 9 })];
    expect(openerSeries(span, rows)).toEqual([
      { day: '2026-10-01', replied: 0, noReply: 0, pending: 0 },
      { day: '2026-10-02', replied: 2, noReply: 1, pending: 1 },
      { day: '2026-10-03', replied: 0, noReply: 0, pending: 0 },
    ]);
    expect(openerSeries(span, undefined).map((d) => d.replied)).toEqual([0, 0, 0]);
  });
  it('fills all 24 hours', () => {
    const hours = hourSeries([row('00', 10, 1), row('23', 20, 1)]);
    expect(hours).toHaveLength(24);
    expect(hours[0]).toEqual({ hour: '00', median: 10 });
    expect(hours[5]).toEqual({ hour: '05', median: null });
    expect(hours[23]).toEqual({ hour: '23', median: 20 });
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
    expect(liveLine({ lastLiveAt: null, liveEvents24h: 0 }, now)).toBe('Live: no events yet');
    expect(liveLine({ lastLiveAt: '2026-10-08T11:55:00Z', liveEvents24h: 4 }, now)).toBe(
      'Live: last message event 5m ago · 4 events last 24h',
    );
  });
});
