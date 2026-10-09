import type { StatsFan, StatsFans } from '@api/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { FanLabel } from '@/features/conversations/fan';
import { fanRowState, formatMoney } from '@/features/conversations/format';
import { NoData, Skeleton } from '@/features/stats/cards';
import { formatAgo } from '@/features/stats/series';
import { cn } from '@/lib/utils';

/** How long the search box waits after the last keystroke before searching. */
const SEARCH_DELAY_MS = 300;

/**
 * The fans of `fans`, most spend in the range first; each with a stored chat links to its thread, `selected`
 * highlighted. A payer without a stored chat has no link. The search box sends its text to `onSearch` (the API
 * trims and matches it) once typing pauses; `search` is the text `fans` was asked for.
 */
export function FanList({
  fans,
  search,
  selected,
  onSearch,
}: {
  fans: UseQueryResult<StatsFans>;
  search: string;
  selected: { accountId?: number; chatId?: number };
  onSearch: (search: string) => void;
}) {
  const [filter, setFilter] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => onSearch(filter), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [filter, onSearch]);
  // Labels name the search the shown list answers; while a new one loads, the previous list stays up (placeholder).
  const searched = fans.isPlaceholderData ? '' : search.trim();
  const cut = fans.data && fans.data.total > fans.data.items.length;
  const listed = fans.data ? (cut ? `${fans.data.items.length} of ${fans.data.total} fans` : `${fans.data.total} fans`) : '';

  return (
    <>
      <div className="space-y-2 border-b p-3">
        <Input type="search" placeholder="Search username, name or chat id" aria-label="Search fans" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {fans.data && (
          <p className="text-xs text-muted-foreground">
            {fans.isPlaceholderData ? 'searching… ' : searched ? `matching “${searched}”: ` : ''}
            {listed}, most spend in the range first
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
        ) : fans.data.items.length === 0 && searched ? (
          <p className="p-3 text-sm text-muted-foreground">
            No fan matches “{searched}” among the fans with messages or purchases from {fans.data.from} to {fans.data.to}.
          </p>
        ) : fans.data.items.length === 0 ? (
          <div className="p-3">
            <NoData />
          </div>
        ) : (
          fans.data.items.map((f) => (
            <FanRow key={`${f.accountId}:${f.chatId}`} fan={f} selected={f.accountId === selected.accountId && f.chatId === selected.chatId} />
          ))
        )}
      </div>
    </>
  );
}

/** What a row says in place of the fan's last message time. */
const NO_FAN_MESSAGE = { 'payer-only': 'no stored chat', 'no-message-in-range': 'no message in range', silent: 'fan silent' } as const;

/** One fan: a link to its thread, else (a payer without a stored chat) a plain row. */
function FanRow({ fan: f, selected }: { fan: StatsFan; selected: boolean }) {
  const state = fanRowState(f);
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium">
          <FanLabel fan={f} />
        </span>
        <span className="shrink-0 text-xs text-muted-foreground" title={f.lastFanAt ? new Date(f.lastFanAt).toLocaleString() : undefined}>
          {state !== 'active' ? NO_FAN_MESSAGE[state] : f.lastFanAt && formatAgo(f.lastFanAt)}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        {f.grossAllTime > 0 && (
          <span title="Booked gross in the range / over every stored transaction">
            spent {formatMoney(f.gross)} · all time {formatMoney(f.grossAllTime)}
          </span>
        )}
        {(state === 'silent' || state === 'active') && <span>{f.fanMessages} fan msgs</span>}
        {f.ppvSent > 0 && (
          <span title="PPVs bought / sent (not mass)">
            PPV {f.ppvOpened}/{f.ppvSent}
          </span>
        )}
        {f.tips > 0 && <span>tips {formatMoney(f.tipCents)}</span>}
      </div>
    </>
  );
  return state === 'payer-only' ? (
    <div className="border-b px-3 py-2 text-sm" title={`Fan ${f.chatId}: a payer of the range with no stored messages`}>
      {body}
    </div>
  ) : (
    <Link
      from="/conversations"
      to="/conversations"
      search={(prev) => ({ ...prev, chatAccountId: f.accountId, chatId: f.chatId })}
      aria-current={selected ? 'true' : undefined}
      className={cn('block border-b px-3 py-2 text-sm hover:bg-accent/60', selected && 'bg-accent')}
    >
      {body}
    </Link>
  );
}
