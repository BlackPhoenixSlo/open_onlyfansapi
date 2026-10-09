import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Section } from './ui';

/**
 * The dashboard screenshots in docs/media, keyed by file name without `.png`. Globbed rather than imported, so a
 * screenshot that has not been taken yet renders a placeholder instead of breaking the build.
 */
const SCREENSHOTS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../../../../../docs/media/*.png', { eager: true, query: '?url', import: 'default' }),
  ).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -'.png'.length), url]),
);

/** A 1440×900 screenshot linked to the full-size image, or a neutral box of the same shape until the file exists. */
export function Screenshot({
  name,
  alt,
  loading,
  className,
}: {
  name: string;
  alt: string;
  loading?: 'lazy';
  className?: string;
}) {
  const url = SCREENSHOTS[name];
  if (!url) return <div className={cn('aspect-[1440/900] rounded-lg border bg-muted', className)} />;
  return (
    <a href={url} className={cn('block rounded-lg', className)}>
      <img
        src={url}
        width={1440}
        height={900}
        loading={loading}
        alt={alt}
        className="h-auto w-full rounded-lg border bg-muted"
      />
    </a>
  );
}

const STOPS: { name: string; title: string; alt: string; caption: ReactNode }[] = [
  {
    name: 'home',
    title: 'Home',
    alt: 'Home page with the request count, error rate and active keys of the last 24 hours',
    caption:
      'The last 24 hours at a glance: requests, error rate and active keys, plus any webhook endpoint that needs attention.',
  },
  {
    name: 'accounts',
    title: 'Accounts',
    alt: 'Accounts page listing connected accounts with status badges and a Run analytics button for each',
    caption: (
      <>
        Each connected account with its status badge. <em>Connect account</em> adds one from a browser cURL and a
        proxy, and each active account has a range picker and <em>Run analytics</em> to backfill its last 30, 90 or 180
        days.
      </>
    ),
  },
  {
    name: 'keys',
    title: 'API keys',
    alt: 'API keys page listing a key with its prefix, scope, allowed accounts, last use and status',
    caption: (
      <>
        Create, edit and revoke keys with a name, a <code>read</code> or <code>write</code> scope and an optional
        account allowlist. The secret is shown once; the list shows each key's prefix, scope, accounts and last use.
      </>
    ),
  },
  {
    name: 'playground',
    title: 'Playground',
    alt: 'Playground with the operation search, a GET /v1/{account}/me request form and its 200 response',
    caption:
      'Search the operations (grouped by tag), pick one and an account, add query parameters and send. The response shows the status, latency, request id and headers, with Copy buttons for the curl command and the body.',
  },
  {
    name: 'logs',
    title: 'Logs',
    alt: 'Logs page with status, method, key and account filters above a table of requests',
    caption:
      'Requests made with API keys or from the playground, with time, method, operation, status, duration and key, filtered by status, method, key, account, endpoint or request id. Open a row for its headers and stored bodies, or send it again from the playground.',
  },
  {
    name: 'usage',
    title: 'Usage',
    alt: 'Usage page with a requests-per-day chart and a breakdown table',
    caption:
      'Requests and errors per day over 24 hours, 7 or 30 days, broken down by key, account or endpoint with average latency and bytes, and exported as CSV.',
  },
  {
    name: 'webhooks',
    title: 'Webhooks',
    alt: 'Webhooks page with the Add endpoint button and the Live events feed',
    caption: (
      <>
        Add an HTTPS endpoint, pick its events and send it a test event; each endpoint's page lists its deliveries and
        redelivers one. <em>Live events</em> shows the latest 50 events as they arrive, streamed to the page over
        server-sent events.
      </>
    ),
  },
  {
    name: 'stats',
    title: 'Stats',
    alt: 'Stats page with reply time, SLA and opener cards and charts by day',
    caption:
      'Reply time, reply SLA, openers, scripts and fan turns from the stored chats, for one account or all, over 7 or 30 days or a custom range, with charts by day and by hour of day, a fans table and the raw metric data. A notice tracks a backfill while it runs, and the header says when the last live event and backfill arrived.',
  },
  {
    name: 'conversations',
    title: 'Conversations',
    alt: 'Conversations page with a searchable fan list beside a message thread',
    caption:
      'Every fan with a stored message in the range, searchable by username, name or chat id. Open one to read the thread day by day, hide the mass messages they did not buy, and download it as CSV.',
  },
  {
    name: 'revenue',
    title: 'Revenue',
    alt: 'Revenue page with gross, net and payer cards, gross by day and the top payers',
    caption:
      'Gross and net sales, transactions, payers, fan CVR, golden ratio and DM PPV unlock rate, then gross by day, by transaction kind, and the top 50 payers of the range.',
  },
  {
    name: 'api-reference',
    title: 'API reference',
    alt: 'Interactive API reference at /docs listing the gateway operations',
    caption: (
      <>
        <code>/docs</code> renders the merged OpenAPI spec: OpenOnlyfansAPI's own routes plus every upstream operation as{' '}
        <code>{'/v1/{account}/...'}</code>. It is public on any running gateway, next to <code>/openapi.json</code>.
      </>
    ),
  },
];

export function Tour() {
  return (
    <Section id="tour" title="A tour of the dashboard" intro="Click a screenshot for the full-size image.">
      <div className="mt-7 grid gap-x-8 gap-y-10 md:grid-cols-2">
        {STOPS.map((stop) => (
          <figure key={stop.name} id={`tour-${stop.name}`}>
            <Screenshot name={stop.name} alt={stop.alt} loading="lazy" />
            <figcaption className="pt-3.5">
              <h3 className="mb-1.5 text-lg font-semibold">{stop.title}</h3>
              <p className="text-muted-foreground">{stop.caption}</p>
            </figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}
