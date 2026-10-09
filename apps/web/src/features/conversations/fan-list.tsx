import type { StatsFans } from '@api/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { matchesFan } from '@/features/conversations/format';
import { NoData, Skeleton } from '@/features/stats/cards';
import { formatAgo } from '@/features/stats/series';
import { FAN_LIMIT } from '@/lib/api';
import { cn, fanName, formatMoney } from '@/lib/utils';

/** The fans of `fans`, filtered by username or chat id; each links to its thread, `selected` highlighted. */
export function FanList({ fans, selected }: { fans: UseQueryResult<StatsFans>; selected: { accountId?: number; chatId?: number } }) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => fans.data?.items.filter((f) => matchesFan(f, filter)) ?? [], [fans.data, filter]);
  const cut = fans.data && fans.data.total > fans.data.items.length;
  const listed = fans.data ? (cut ? `${fans.data.items.length} of ${fans.data.total} fans` : `${fans.data.total} fans`) : '';

  return (
    <>
      <div className="space-y-2 border-b p-3">
        <Input type="search" placeholder="Filter by username or chat id" aria-label="Filter fans" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
            const isSelected = f.accountId === selected.accountId && f.chatId === selected.chatId;
            return (
              <Link
                key={`${f.accountId}:${f.chatId}`}
                from="/conversations"
                to="/conversations"
                search={(prev) => ({ ...prev, chatAccountId: f.accountId, chatId: f.chatId })}
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
    </>
  );
}
