import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useMemo } from 'react';
import { FilterSelect } from '@/components/filter-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addDays, liveLine, refreshLine, todayIn } from '@/features/stats/series';
import { type StatsRange, accountsQuery, statsConfigQuery } from '@/lib/api';
import { day, positiveInt } from '@/lib/search';

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
 * The preset (default 30d) and API range for the search params: a preset ends today in the stats timezone `tz`; a
 * custom range without days falls back to the API default (30 days). `tz` is undefined while the config loads (no
 * range yet) and null when it failed (the API picks its default range).
 */
export function searchRange(search: RangeSearch, tz: string | null | undefined): { preset: Preset; range: StatsRange | undefined } {
  const preset = search.range ?? '30d';
  const { from, to, accountId } = search;
  if (preset === 'custom') return { preset, range: { from, to, accountId } };
  if (tz === undefined) return { preset, range: undefined };
  if (tz === null) return { preset, range: { accountId } };
  const end = todayIn(tz);
  return { preset, range: { from: addDays(end, -(PRESET_DAYS[preset] - 1)), to: end, accountId } };
}

/** A stats page's config query, timezone, account filter, preset and API range for its search params (see `searchRange`). */
export function useStatsRange(search: RangeSearch) {
  const config = useQuery(statsConfigQuery);
  const tz = config.data?.config.timezone;
  // A failed background refetch keeps the timezone already known.
  const zone = tz ?? (config.isError ? null : undefined);
  const { range, from, to, accountId } = search;
  const resolved = useMemo(() => searchRange({ range, from, to, accountId }, zone), [range, from, to, accountId, zone]);
  return { config, tz, accountId, ...resolved };
}

/** What `useStatsRange` returns. */
export type StatsRangeState = ReturnType<typeof useStatsRange>;

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
 * A stats page's title row with the account filter and range presets, the day inputs for a custom range, the days
 * `served` (the API's answer) with the config and the live-event line, then `children`. `stats` is the page's
 * `useStatsRange`. A change merges into the current page's search params; choosing custom seeds the days shown
 * (`range`, else `served`).
 */
export function RangeControls({
  title,
  stats: { config, accountId, preset, range },
  served,
  children,
}: {
  title: string;
  stats: Pick<StatsRangeState, 'config' | 'accountId' | 'preset' | 'range'>;
  served: { from: string; to: string; asOf: string } | undefined;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const onChange = (next: RangeSearch) => navigate({ to: '.', search: (prev) => ({ ...prev, ...next }) });
  const accounts = useQuery(accountsQuery);
  const cfg = config.data?.config;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            all="All accounts"
            className="w-48"
            value={accountId === undefined ? undefined : String(accountId)}
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
      <p className="text-xs text-muted-foreground">
        {served ? `${served.from} to ${served.to} · ` : ''}
        {cfg ? `timezone ${cfg.timezone} · config v${cfg.version}` : 'loading config…'}
        {served && ` · as of ${new Date(served.asOf).toLocaleString()}`}
      </p>
      {config.data && (
        <>
          <p className="text-xs text-muted-foreground" title={config.data.freshness.lastLiveAt ?? undefined}>
            {liveLine(config.data.freshness)}
          </p>
          <p className="text-xs text-muted-foreground" title={config.data.freshness.lastRefreshAt ?? undefined}>
            {refreshLine(config.data.freshness)}
          </p>
        </>
      )}
      {children}
    </div>
  );
}
