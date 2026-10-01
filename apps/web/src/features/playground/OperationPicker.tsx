import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { type Op, groupByTag } from './spec';

const METHOD_TONE: Record<string, string> = {
  GET: 'text-emerald-700 dark:text-emerald-400',
  POST: 'text-sky-700 dark:text-sky-400',
  PUT: 'text-amber-700 dark:text-amber-400',
  PATCH: 'text-amber-700 dark:text-amber-400',
  DELETE: 'text-destructive',
};

/** Operations grouped by tag, filtered by a search over method, path and summary. */
export function OperationPicker({ ops, selected, onSelect }: { ops: Op[]; selected: string | undefined; onSelect: (op: Op) => void }) {
  const [search, setSearch] = useState('');
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = ops.filter((op) => {
    const text = `${op.id} ${op.summary ?? ''}`.toLowerCase();
    return terms.every((t) => text.includes(t));
  });

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search operations…" aria-label="Search operations" />
      <div className="max-h-[70vh] overflow-y-auto rounded-md border">
        {visible.length === 0 && <p className="p-3 text-sm text-muted-foreground">No operations match.</p>}
        {groupByTag(visible).map(([tag, group]) => (
          <section key={tag}>
            <h2 className="sticky top-0 border-b bg-background px-3 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {tag} <span className="font-normal">({group.length})</span>
            </h2>
            <ul>
              {group.map((op) => (
                <li key={op.id}>
                  <button
                    type="button"
                    title={op.summary}
                    onClick={() => onSelect(op)}
                    className={cn(
                      'flex w-full items-baseline gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-muted',
                      op.id === selected && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span className={cn('w-12 shrink-0 font-semibold', METHOD_TONE[op.method])}>{op.method}</span>
                    <span className="break-all">{op.path.replace(/^\/v1\/\{account\}/, '') || '/'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
