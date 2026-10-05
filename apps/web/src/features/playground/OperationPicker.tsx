import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { type Op, groupOps } from './spec';

const METHOD_TONE: Record<string, string> = {
  GET: 'text-emerald-700 dark:text-emerald-400',
  POST: 'text-sky-700 dark:text-sky-400',
  PUT: 'text-amber-700 dark:text-amber-400',
  PATCH: 'text-amber-700 dark:text-amber-400',
  DELETE: 'text-destructive',
};

/** A "Recent" group, then operations grouped by tag, platform ones by path segment (collapsed by default), filtered by a search over method, path, summary and operationId. */
export function OperationPicker({
  ops,
  recent,
  selected,
  onSelect,
}: {
  ops: Op[];
  /** Recently sent operation ids, most recent first. */
  recent: string[];
  selected: string | undefined;
  onSelect: (op: Op) => void;
}) {
  const [search, setSearch] = useState('');
  // Groups the user toggled away from their default (platform sub-groups start collapsed, the others open).
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = ops.filter((op) => {
    const text = `${op.id} ${op.summary ?? ''} ${op.operationId ?? ''}`.toLowerCase();
    return terms.every((t) => text.includes(t));
  });
  const recentOps = recent.flatMap((id) => visible.filter((op) => op.id === id));
  const groups = groupOps(visible);
  if (recentOps.length > 0) groups.unshift(['Recent', recentOps]);
  const toggle = (group: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (!next.delete(group)) next.add(group);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search operations…" aria-label="Search operations" />
      <div className="max-h-[70vh] overflow-y-auto rounded-md border">
        {visible.length === 0 && <p className="p-3 text-sm text-muted-foreground">No operations match.</p>}
        {groups.map(([group, list]) => {
          // A search shows every match, collapsed groups included.
          const collapsedByDefault = group.startsWith('platform / ');
          const open = terms.length > 0 || (collapsedByDefault ? toggled.has(group) : !toggled.has(group));
          return (
            <section key={group}>
              <h2 className="sticky top-0 z-10 border-b bg-background">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggle(group)}
                  className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
                >
                  {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  {group} <span className="font-normal">({list.length})</span>
                </button>
              </h2>
              {open && (
                <ul>
                  {list.map((op) => (
                    <li key={op.id}>
                      <button
                        type="button"
                        title={op.operationId}
                        onClick={() => onSelect(op)}
                        className={cn(
                          'flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-muted',
                          op.id === selected && 'bg-accent text-accent-foreground',
                        )}
                      >
                        <span className={cn('w-12 shrink-0 font-mono text-xs font-semibold', METHOD_TONE[op.method])}>{op.method}</span>
                        <span className="min-w-0">
                          <span className="block font-mono text-xs break-all">{op.path.replace(/^\/v1\/\{account\}/, '') || '/'}</span>
                          {op.summary && <span className="block text-xs text-muted-foreground">{op.summary}</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
