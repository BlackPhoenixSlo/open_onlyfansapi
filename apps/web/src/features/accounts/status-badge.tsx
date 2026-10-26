import { Badge } from '@/components/ui/badge';

/** The Accounts row's tooltip: OF also refuses a session that needs a 2FA code, which only a new login can enter. */
export const SESSION_EXPIRED_HINT =
  "OnlyFans refused this account's session, or wants its 2FA code. Log in again with Try Browserbase login or " +
  'Browser login (both take the 2FA code), or use Connect account with a fresh cURL for the same account.';

/** OF refused the account's session (upstream status or a run's 401): the owner must re-connect it. */
export function SessionExpiredBadge({ title }: { title?: string }) {
  return (
    <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400" title={title}>
      Session expired · re-connect
    </Badge>
  );
}
