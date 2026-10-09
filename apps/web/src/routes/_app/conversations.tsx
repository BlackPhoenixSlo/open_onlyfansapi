import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { FanList } from '@/features/conversations/fan-list';
import { Thread } from '@/features/conversations/thread';
import { ErrorCard, Skeleton, WorkspaceNotLinked, isTeamNotLinked } from '@/features/stats/cards';
import { RangeControls, type RangeSearch, rangeSearch, useStatsRange } from '@/features/stats/range';
import { addDays } from '@/features/stats/series';
import { FAN_LIMIT, THREAD_DAYS, statsFansQuery } from '@/lib/api';
import { positiveInt } from '@/lib/search';

/** `accountId` filters the list; the open thread is `chatAccountId` + `chatId`. */
type Search = RangeSearch & { chatAccountId?: number; chatId?: number };

export const Route = createFileRoute('/_app/conversations')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...rangeSearch(s),
    chatAccountId: positiveInt(s.chatAccountId),
    chatId: positiveInt(s.chatId),
  }),
  component: Conversations,
});

function Conversations() {
  const search = Route.useSearch();
  const stats = useStatsRange(search);
  const { config, range } = stats;
  // The fan list's search, as sent to the API; the previous list stays up while a new search loads.
  const [fanSearch, setFanSearch] = useState('');
  const fans = useQuery({
    ...statsFansQuery({ ...range, limit: FAN_LIMIT, search: fanSearch }),
    enabled: range !== undefined,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  if (isTeamNotLinked([config, fans])) return <WorkspaceNotLinked title="Conversations" subject="each fan's messages" />;

  const { chatId, chatAccountId } = search;
  // The thread ends with the list's range as the API resolved it.
  const threadTo = fans.data?.to;

  return (
    <div className="space-y-4">
      <RangeControls
        title="Conversations"
        search={search}
        stats={stats}
        served={fans.data}
      />

      {config.isError && <ErrorCard message={config.error.message} />}

      <div className="grid gap-4 lg:h-[calc(100vh-12rem)] lg:min-h-[32rem] lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="flex h-[28rem] min-h-0 flex-col rounded-xl border bg-card lg:h-auto">
          <FanList fans={fans} search={fanSearch} selected={{ accountId: chatAccountId, chatId }} onSearch={setFanSearch} />
        </div>

        <div className="flex h-[36rem] min-h-0 flex-col rounded-xl border bg-card lg:h-auto">
          {chatId === undefined || chatAccountId === undefined ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">Pick a fan to read the conversation.</div>
          ) : threadTo === undefined ? (
            fans.isError ? (
              <p className="p-4 text-sm text-destructive">The thread needs the fan list's range: {fans.error.message}</p>
            ) : (
              <Skeleton className="m-4 h-40" />
            )
          ) : (
            <Thread
              key={`${chatAccountId}:${chatId}:${threadTo}`}
              params={{ from: addDays(threadTo, -(THREAD_DAYS - 1)), to: threadTo, accountId: chatAccountId, chatId }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
