import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rangeSearch, searchRange } from './range';

describe('stats range search params', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('keeps well-formed params and drops malformed ones', () => {
    expect(rangeSearch({ range: '7d', from: '2026-09-01', to: '2026-09-30', accountId: '12' })).toEqual({
      range: '7d',
      from: '2026-09-01',
      to: '2026-09-30',
      accountId: 12,
    });
    expect(rangeSearch({ range: '90d', from: '2026-13-01', to: '2026-02-30', accountId: '-3' })).toEqual({
      range: undefined,
      from: undefined,
      to: undefined,
      accountId: undefined,
    });
  });

  it('ends a preset today in the stats timezone, 30d by default', () => {
    expect(searchRange({ range: '7d', accountId: 5 }, 'UTC')).toEqual({ preset: '7d', range: { from: '2026-10-03', to: '2026-10-09', accountId: 5 } });
    expect(searchRange({}, 'UTC')).toEqual({ preset: '30d', range: { from: '2026-09-10', to: '2026-10-09', accountId: undefined } });
    vi.setSystemTime(new Date('2026-10-09T23:30:00Z'));
    expect(searchRange({ range: '7d' }, 'Europe/Berlin').range?.to).toBe('2026-10-10');
  });

  it('passes a custom range through, days or not', () => {
    expect(searchRange({ range: 'custom', from: '2026-09-01', to: '2026-09-04' }, undefined).range).toEqual({
      from: '2026-09-01',
      to: '2026-09-04',
      accountId: undefined,
    });
    expect(searchRange({ range: 'custom', accountId: 2 }, 'UTC').range).toEqual({ from: undefined, to: undefined, accountId: 2 });
  });

  it('waits for the timezone, and leaves the range to the API when the config failed', () => {
    expect(searchRange({ range: '30d', accountId: 2 }, undefined).range).toBeUndefined();
    expect(searchRange({ range: '30d', accountId: 2 }, null).range).toEqual({ accountId: 2 });
  });
});
