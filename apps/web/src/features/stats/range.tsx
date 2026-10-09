import { useQuery } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { FilterSelect } from '@/components/filter-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addDays, todayIn } from '@/features/stats/series';
import { type StatsRange, accountsQuery } from '@/lib/api';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** `v` when it is a `YYYY-MM-DD` day, else undefined. */
export const day = (v: unknown) => (typeof v === 'string' && DAY.test(v) ? v : undefined);

/** `v` when it is (a string of) a positive integer, else undefined. */
export const positiveInt = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

const PRESET_DAYS = { '7d': 7, '30d': 30 } as const;
export type Preset = keyof typeof PRESET_DAYS | 'custom';
export const PRESETS: Preset[] = ['7d', '30d', 'custom'];

export type RangeSearch = { range?: Preset; from?: string; to?: string; accountId?: number };

/** The range search params of a stats page; a malformed one is dropped. */
export const rangeSearch = (s: Record<string, unknown>): RangeSearch => ({
  range: PRESETS.find((p) => p === s.range),
  from: day(s.from),
  to: day(s.to),
  accountId: positiveInt(s.accountId),
});

/**
 * The API range for the search params: a preset (default 30d) ends today in the stats timezone `tz`; a custom range
 * without days falls back to the API default (30 days). Undefined while `tz` loads; without the config
 * (`configFailed`, an error the page shows) the API picks its default range.
 */
export function searchRange(search: RangeSearch, tz: string | undefined, configFailed: boolean): StatsRange | undefined {
  const preset = search.range ?? '30d';
  if (preset === 'custom') return { from: search.from, to: search.to, accountId: search.accountId };
  if (!tz) return configFailed ? { accountId: search.accountId } : undefined;
  const to = todayIn(tz);
  return { from: addDays(to, -(PRESET_DAYS[preset] - 1)), to, accountId: search.accountId };
}

export function Segmented<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <Button key={o} size="sm" variant={o === value ? 'default' : 'ghost'} aria-pressed={o === value} className="capitalize" onClick={() => onChange(o)}>
          {o}
        </Button>
      ))}
    </div>
  );
}

/** From/to day inputs; `onApply` gets each as a day or undefined. */
export function CustomRange({ from, to, onApply }: { from?: string; to?: string; onApply: (from?: string, to?: string) => void }) {
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    onApply(day(data.get('from')), day(data.get('to')));
  }
  return (
    <form key={`${from}|${to}`} onSubmit={onSubmit} className="flex flex-wrap items-center justify-end gap-2">
      <Input name="from" type="date" defaultValue={from} aria-label="From" className="w-40" />
      <span className="text-muted-foreground">to</span>
      <Input name="to" type="date" defaultValue={to} aria-label="To (inclusive)" className="w-40" />
      <Button type="submit" variant="secondary">
        Apply
      </Button>
    </form>
  );
}

/**
 * A stats page's title row with the account filter and range presets, and the day inputs for a custom range.
 * `onChange` gets the search params to change; choosing custom seeds the days shown (`range`, else `served`, the
 * days the API answered for).
 */
export function RangeControls({
  title,
  search,
  range,
  served,
  onChange,
}: {
  title: string;
  search: RangeSearch;
  range: StatsRange | undefined;
  served: { from: string; to: string } | undefined;
  onChange: (next: RangeSearch) => void;
}) {
  const accounts = useQuery(accountsQuery);
  const preset = search.range ?? '30d';
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            all="All accounts"
            className="w-48"
            value={search.accountId === undefined ? undefined : String(search.accountId)}
            options={(accounts.data?.items ?? []).map((a) => ({
              value: String(a.id),
              label: a.username ? `@${a.username}` : (a.label ?? String(a.id)),
            }))}
            onChange={(v) => onChange({ accountId: v ? Number(v) : undefined })}
          />
          <Segmented
            options={PRESETS}
            value={preset}
            onChange={(next) =>
              onChange(
                next === 'custom'
                  ? { range: next, from: range?.from ?? served?.from, to: range?.to ?? served?.to }
                  : { range: next, from: undefined, to: undefined },
              )
            }
          />
        </div>
      </div>
      {preset === 'custom' && (
        <CustomRange from={range?.from} to={range?.to} onApply={(from, to) => onChange({ range: 'custom', from, to })} />
      )}
    </>
  );
}
