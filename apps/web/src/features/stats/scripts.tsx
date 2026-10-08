import type { StatsScript } from '@api/contracts';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { COLORS } from '@/features/stats/chart';
import { formatPercent } from '@/features/stats/series';

export function ScriptCard({ script: s }: { script: StatsScript }) {
  const decided = s.replied + s.noReply;
  async function copyHash() {
    try {
      await navigator.clipboard.writeText(s.hash);
      toast.success('Hash copied');
    } catch {
      toast.error('Could not copy the hash');
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <blockquote className="line-clamp-3 border-l-2 pl-3 text-sm italic" title={s.variants[0]?.text}>
        {s.variants[0]?.text ?? '—'}
      </blockquote>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span>
          <b className="tabular-nums">{s.sends}</b> sends <span className="text-muted-foreground">/ {s.sendsAll} all-time</span>
        </span>
        <span>
          <b className="tabular-nums">{s.chats}</b> chats <span className="text-muted-foreground">/ {s.chatsAll} all-time</span>
        </span>
        {s.variantCount > 1 && <span className="text-xs text-muted-foreground">{s.variantCount} variants</span>}
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span>Fan replied {formatPercent(s.replyRate)}</span>
          <span className="text-muted-foreground">
            {s.replied} of {decided}
            {s.pending ? ` · ${s.pending} pending` : ''}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full" style={{ width: `${s.replyRate ?? 0}%`, background: COLORS.ok }} />
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <code className="text-xs text-muted-foreground">{s.hash}</code>
        <Button size="sm" variant="ghost" onClick={copyHash}>
          <Copy className="size-3.5" />
          Copy hash
        </Button>
      </div>
    </div>
  );
}
