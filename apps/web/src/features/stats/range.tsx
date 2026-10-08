import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** `v` when it is a `YYYY-MM-DD` day, else undefined. */
export const day = (v: unknown) => (typeof v === 'string' && DAY.test(v) ? v : undefined);

export function Segmented<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <Button key={o} size="sm" variant={o === value ? 'default' : 'ghost'} aria-pressed={o === value} className="capitalize" onClick={() => onChange(o)}>
          {o}
        </Button>
      ))}
    </div>
  );
}

/** From/to day inputs; `onApply` gets each as a day or undefined. */
export function CustomRange({ from, to, onApply }: { from?: string; to?: string; onApply: (from?: string, to?: string) => void }) {
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    onApply(day(data.get('from')), day(data.get('to')));
  }
  return (
    <form key={`${from}|${to}`} onSubmit={onSubmit} className="flex flex-wrap items-center justify-end gap-2">
      <Input name="from" type="date" defaultValue={from} aria-label="From" className="w-40" />
      <span className="text-muted-foreground">to</span>
      <Input name="to" type="date" defaultValue={to} aria-label="To (inclusive)" className="w-40" />
      <Button type="submit" variant="secondary">
        Apply
      </Button>
    </form>
  );
}
