import type { StatsFan, StatsMessage } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { byDay, fanName, isHiddenMass, messageBadges, noTextLabel } from '@/features/conversations/format';
import { Skeleton } from '@/features/stats/cards';
import { type StatsRange, statsConversationQuery, statsMessagesCsvPath } from '@/lib/api';
import { useCsvDownload } from '@/lib/download';
import { cn } from '@/lib/utils';

/**
 * One fan's conversation over `params`, oldest first and opened at the newest: fan messages left, the creator's
 * right, by day in the stats timezone; mass messages the fan did not buy hidden unless untoggled. Mount it with a
 * `key` per chat and range so it scrolls down again.
 */
export function Thread({ params, fan }: { params: StatsRange & { chatId: number }; fan: StatsFan | undefined }) {
  const thread = useQuery(statsConversationQuery(params));
  const csv = useCsvDownload();
  const [hideMass, setHideMass] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const data = thread.data;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!data || !el || scrolled.current) return;
    el.scrollTop = el.scrollHeight;
    scrolled.current = true;
  }, [data]);
  // Toggling mass messages changes the height above the reader; keep the newest messages in view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [hideMass]);

  const view = useMemo(() => {
    if (!data) return undefined;
    const shown = hideMass ? data.items.filter((m) => !isHiddenMass(m)) : data.items;
    const day = new Intl.DateTimeFormat(undefined, { timeZone: data.timezone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const time = new Intl.DateTimeFormat(undefined, { timeZone: data.timezone, hour: '2-digit', minute: '2-digit' });
    return {
      groups: byDay(shown, data.timezone).map((g) => ({ ...g, label: day.format(new Date(g.items[0]!.createdAt)) })),
      hidden: data.items.length - shown.length,
      time: (iso: string) => time.format(new Date(iso)),
    };
  }, [data, hideMass]);

  const name = fanName({ fanUsername: fan?.fanUsername ?? data?.items[0]?.fanUsername ?? null, chatId: params.chatId });
  const count = data?.items.length ?? 0;

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b p-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{name}</div>
          <div className="text-xs text-muted-foreground">
            chat {params.chatId}
            {data && ` · ${count.toLocaleString()} messages · ${data.from} to ${data.to} · times in ${data.timezone}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={hideMass} onChange={(e) => setHideMass(e.target.checked)} />
            Hide mass
          </label>
          {hideMass && view && view.hidden > 0 && <span className="text-xs text-muted-foreground">{view.hidden} mass hidden</span>}
          <Button
            size="sm"
            variant="outline"
            disabled={csv.downloading || !count}
            onClick={() =>
              csv.download(
                statsMessagesCsvPath({ ...params, direction: 'all' }),
                `messages-${fan?.fanUsername ?? params.chatId}-${data?.from}-${data?.to}.csv`,
              )
            }
          >
            Download CSV
          </Button>
        </div>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-4">
        {thread.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-2/3" />
            <Skeleton className="ml-auto h-12 w-1/2" />
            <Skeleton className="h-12 w-3/5" />
          </div>
        ) : thread.isError ? (
          <p className="text-destructive">{thread.error.message}</p>
        ) : !view || count === 0 ? (
          <p className="text-sm text-muted-foreground">
            No messages with this fan stored from {data?.from ?? params.from} to {data?.to ?? params.to}.
          </p>
        ) : view.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">Only mass messages the fan did not buy; untick Hide mass to see them.</p>
        ) : (
          <div className="space-y-4">
            {view.groups.map((g) => (
              <section key={g.day} className="space-y-2">
                <div className="sticky top-0 z-10 flex justify-center">
                  <span className="rounded-full border bg-background px-3 py-0.5 text-xs text-muted-foreground">{g.label}</span>
                </div>
                {g.items.map((m) => (
                  <Bubble key={`${m.accountId}:${m.messageId}`} m={m} time={view.time(m.createdAt)} />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Bubble({ m, time }: { m: StatsMessage; time: string }) {
  const fromFan = m.direction === 'inbound';
  return (
    <div className={cn('flex', fromFan ? 'justify-start' : 'justify-end')}>
      <div
        className={cn(
          'max-w-[80%] space-y-1 rounded-2xl border px-3 py-2 text-sm',
          fromFan ? 'rounded-bl-sm bg-muted' : 'rounded-br-sm bg-primary/10',
          m.deletedAt && 'opacity-50',
        )}
      >
        {m.text ? <p className="break-words">{m.text}</p> : <p className="italic text-muted-foreground">{noTextLabel(m)}</p>}
        <div className={cn('flex flex-wrap items-center gap-1', !fromFan && 'justify-end')}>
          {messageBadges(m).map((b) => (
            <Badge key={b.label} variant={b.variant}>
              {b.label}
            </Badge>
          ))}
          <time dateTime={m.createdAt} className="text-[11px] text-muted-foreground">
            {time}
          </time>
        </div>
      </div>
    </div>
  );
}
