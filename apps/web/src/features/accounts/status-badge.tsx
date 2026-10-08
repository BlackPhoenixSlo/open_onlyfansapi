import { Badge } from '@/components/ui/badge';

/** OF refused the account's session (upstream status or a run's 401): the owner must re-connect it. */
export function SessionExpiredBadge({ title }: { title?: string }) {
  return (
    <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400" title={title}>
      Session expired · re-connect
    </Badge>
  );
}
