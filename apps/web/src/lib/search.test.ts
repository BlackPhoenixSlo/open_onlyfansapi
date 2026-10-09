import { describe, expect, it } from 'vitest';
import { day, nonEmpty, positiveInt } from './search';

describe('search param parsers', () => {
  it('reads only days that exist', () => {
    expect([day('2028-02-29'), day('2026-02-29'), day('2026-13-01'), day('2026-9-1'), day(20260901)]).toEqual([
      '2028-02-29',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('reads positive integers, from strings too', () => {
    expect([positiveInt('7'), positiveInt(7), positiveInt('0'), positiveInt('1.5'), positiveInt('x')]).toEqual([7, 7, undefined, undefined, undefined]);
  });

  it('reads non-empty strings', () => {
    expect([nonEmpty('reply_time'), nonEmpty(''), nonEmpty(3), nonEmpty(undefined)]).toEqual(['reply_time', undefined, undefined, undefined]);
  });
});
