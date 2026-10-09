import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { fanName, matchesFan } from '@/features/conversations/format';
import { Thread } from '@/features/conversations/thread';
import { ErrorCard, NoData, Skeleton, WorkspaceNotLinked } from '@/features/stats/cards';
import { RangeControls, type RangeSearch, positiveInt, rangeSearch, searchRange } from '@/features/stats/range';
import { addDays, formatAgo, todayIn } from '@/features/stats/series';
import { ApiError, statsConfigQuery, statsFansQuery } from '@/lib/api';
import { cn, formatMoney } from '@/lib/utils';

/** `accountId` filters the list; the open thread is `chatAccountId` + `chatId`. */
type Search = RangeSearch & { chatAccountId?: number; chatId?: number; q?: string };

export const Route = createFileRoute('/_app/conversations')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...rangeSearch(s),
    chatAccountId: positiveInt(s.chatAccountId),
    chatId: positiveInt(s.chatId),
    q: typeof s.q === 'string' && s.q ? s.q : undefined,
  }),
  component: Conversations,
});

/** The API's maximum; past it the list says "N of total". */
const FAN_LIMIT = 1000;
/** A thread spans this many days up to the range's end: the API's longest range (`MAX_DAYS`). */
const THREAD_DAYS = 366;

function Conversations() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const preset = search.range ?? '30d';
  // Local so typing never waits on the router; resynced when the URL's `q` changes (back/forward, nav link).
  const [filter, setFilter] = useState(search.q ?? '');
  useEffect(() => setFilter(search.q ?? ''), [search.q]);

  const config = useQuery(statsConfigQuery);
  const tz = config.data?.config.timezone;
  const range = useMemo(
    () => searchRange({ range: preset, from: search.from, to: search.to, accountId: search.accountId }, tz, config.isError),
    [preset, search.from, search.to, search.accountId, tz, config.isError],
  );
  const fans = useQuery({ ...statsFansQuery({ ...range, limit: FAN_LIMIT }), enabled: range !== undefined, staleTime: 60_000 });
  const shown = useMemo(() => fans.data?.items.filter((f) => matchesFan(f, filter)) ?? [], [fans.data, filter]);
  const newest = useMemo(() => fans.data?.items.reduce<string | undefined>((max, f) => (max && max > f.lastAt ? max : f.lastAt), undefined), [fans.data]);

  const unlinked = [config, fans].some((q) => q.error instanceof ApiError && q.error.code === 'team_not_linked');
  if (unlinked) {
    return <WorkspaceNotLinked title="Conversations">Conversations show the messages the analytics backfill stored for this workspace.</WorkspaceNotLinked>;
  }

  const { chatId, chatAccountId } = search;
  const selected = fans.data?.items.find((f) => f.chatId === chatId && f.accountId === chatAccountId);
  // The thread ends with the list's range; a custom range without `to` ends today.
  const threadTo = range?.to ?? (tz ? todayIn(tz) : undefined);
  const threadFrom = threadTo && addDays(threadTo, -(THREAD_DAYS - 1));
  const cut = fans.data && fans.data.total > fans.data.items.length;
  const listed = fans.data ? (cut ? `${fans.data.items.length} of ${fans.data.total} fans` : `${fans.data.total} fans`) : '';

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <RangeControls
          title="Conversations"
          search={search}
          range={range}
          served={fans.data}
          onChange={(next) =>
            navigate({
              search: (prev) => ({ ...prev, ...next }),
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          {fans.data ? `${fans.data.from} to ${fans.data.to} · ` : ''}
          {tz ? `timezone ${tz}` : 'loading config…'}
          {newest && (
            <span title={new Date(newest).toLocaleString()}> · newest stored message {formatAgo(newest)}</span>
          )}
        </p>
      </div>

      {config.isError && <ErrorCard message={config.error.message} />}

      <div className="grid gap-4 lg:h-[calc(100vh-12rem)] lg:min-h-[32rem] lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="flex h-[28rem] min-h-0 flex-col rounded-xl border bg-card lg:h-auto">
          <div className="space-y-2 border-b p-3">
            <Input
              type="search"
              placeholder="Filter by username or chat id"
              aria-label="Filter fans"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                navigate({ search: (prev) => ({ ...prev, q: e.target.value || undefined }), replace: true });
              }}
            />
            {fans.data && (
              <p className="text-xs text-muted-foreground">
                {filter.trim() ? `${shown.length} matching · ` : ''}
                {listed}, latest fan message first
              </p>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {fans.isPending ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : fans.isError ? (
              <p className="p-3 text-sm text-destructive">{fans.error.message}</p>
            ) : fans.data.items.length === 0 ? (
              <div className="p-3">
                <NoData />
              </div>
            ) : shown.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                No fan matches “{filter.trim()}”. Not among the {fans.data.items.length} fans with messages from {fans.data.from} to{' '}
                {fans.data.to}
                {cut && ` (list cut at ${FAN_LIMIT} of ${fans.data.total})`}.
              </p>
            ) : (
              shown.map((f) => {
                const isSelected = f === selected;
                return (
                  <Link
                    key={`${f.accountId}:${f.chatId}`}
                    to="/conversations"
                    search={{ ...search, chatAccountId: f.accountId, chatId: f.chatId }}
                    aria-current={isSelected ? 'true' : undefined}
                    className={cn('block border-b px-3 py-2 text-sm hover:bg-accent/60', isSelected && 'bg-accent')}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium">{fanName(f)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground" title={f.lastFanAt ? new Date(f.lastFanAt).toLocaleString() : undefined}>
                        {f.lastFanAt ? formatAgo(f.lastFanAt) : 'fan silent'}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span>{f.fanMessages} fan msgs</span>
                      {f.ppvSent > 0 && (
                        <span title="PPVs bought / sent (not mass)">
                          PPV {f.ppvOpened}/{f.ppvSent}
                        </span>
                      )}
                      {f.tips > 0 && <span>tips {formatMoney(f.tipCents)}</span>}
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>

        <div className="flex h-[36rem] min-h-0 flex-col rounded-xl border bg-card lg:h-auto">
          {chatId === undefined || chatAccountId === undefined ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">Pick a fan to read the conversation.</div>
          ) : range === undefined ? (
            <Skeleton className="m-4 h-40" />
          ) : (
            <Thread
              key={`${chatAccountId}:${chatId}:${threadTo}`}
              params={{ from: threadFrom, to: threadTo, accountId: chatAccountId, chatId }}
              fan={selected}
            />
          )}
        </div>
      </div>
    </div>
  );
}
