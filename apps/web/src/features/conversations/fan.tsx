import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { type FanNamed, fanName } from '@/features/conversations/format';

/** `children` (default the fan's name), tagged when the fan deleted their OF account. */
export function FanLabel({ fan, children = fanName(fan) }: { fan: FanNamed & { isDeleted: boolean }; children?: ReactNode }) {
  return (
    <>
      {children}
      {fan.isDeleted && <span className="ml-2 text-xs font-normal text-muted-foreground">deleted account</span>}
    </>
  );
}

/** A link to the fan's thread on the Conversations page over `range` (a response's `from`/`to`), named `children` (default the fan's name). */
export function ConversationLink({ fan, range, children = fanName(fan) }: { fan: FanNamed & { accountId: number }; range: { from: string; to: string }; children?: ReactNode }) {
  return (
    <Link
      to="/conversations"
      search={{ range: 'custom', from: range.from, to: range.to, chatAccountId: fan.accountId, chatId: fan.chatId }}
      className="underline-offset-4 hover:underline"
      title="Read the conversation"
    >
      {children}
    </Link>
  );
}
