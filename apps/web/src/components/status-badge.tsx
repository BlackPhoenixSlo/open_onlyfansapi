import { Badge } from '@/components/ui/badge';

export function StatusBadge({ status }: { status: number }) {
  if (status >= 500) return <Badge variant="destructive">{status}</Badge>;
  const tone =
    status >= 400
      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
      : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
  return <Badge className={tone}>{status}</Badge>;
}
