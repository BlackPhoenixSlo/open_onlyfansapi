import { Fragment, type ReactNode } from 'react';

/** A two-column label / value list. */
export function Pairs({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
