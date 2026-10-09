import { Link, createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Screenshot, Tour } from '@/features/landing/tour';
import { Tutorial } from '@/features/landing/tutorial';
import { Pre, RepoLink, Section, repoUrl } from '@/features/landing/ui';
import { authClient } from '@/lib/auth-client';
import { PRODUCT_NAME } from '@/lib/brand';

/** The public landing page; the signed-in home is /dashboard. */
export const Route = createFileRoute('/')({ component: Landing });

const GETTING_STARTED = repoUrl('docs/getting-started.md');

const INLINE_CODE =
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:border [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:text-[0.88em] [&_:not(pre)>code]:[overflow-wrap:anywhere]';

function Landing() {
  return (
    <div className={`mx-auto max-w-[1120px] px-6 leading-relaxed ${INLINE_CODE}`}>
      <Header />
      <main>
        <Hero />
        <Features />
        <HowItFits />
        <Tour />
        <Tutorial />
      </main>
      <Footer />
    </div>
  );
}

const NAV_LINK = 'text-sm text-muted-foreground hover:text-foreground';

function Header() {
  return (
    <nav className="flex flex-wrap items-center gap-x-[22px] gap-y-2 py-[18px]" aria-label="Main">
      <a href="#" className="mr-auto text-lg font-semibold">
        {PRODUCT_NAME}
      </a>
      <a href="#features" className={NAV_LINK}>
        Features
      </a>
      <a href="#how-it-fits" className={NAV_LINK}>
        How it fits
      </a>
      <a href="#tour" className={NAV_LINK}>
        Tour
      </a>
      <a href="#tutorial" className={NAV_LINK}>
        Tutorial
      </a>
      <a href={GETTING_STARTED} className={NAV_LINK}>
        Docs
      </a>
      <AuthButtons />
    </nav>
  );
}

/** "Log in" and "Register", or "Open dashboard" once the session check finds a session. */
function AuthButtons() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return null;
  if (session) {
    return (
      <Button asChild size="sm">
        <Link to="/dashboard">Open dashboard</Link>
      </Button>
    );
  }
  return (
    <div className="flex gap-2">
      <Button asChild variant="outline" size="sm">
        <Link to="/login">Log in</Link>
      </Button>
      <Button asChild size="sm">
        <Link to="/register">Register</Link>
      </Button>
    </div>
  );
}

function Hero() {
  return (
    <section className="pt-10 pb-16">
      <h1 className="mb-4 text-[clamp(2.5rem,7vw,3.75rem)] leading-[1.05] font-bold tracking-tight">{PRODUCT_NAME}</h1>
      <p className="mb-3 max-w-[46rem] text-xl">
        A self-hosted API gateway and dashboard for a creator-platform service, with the upstream service included.
      </p>
      <p className="max-w-[46rem] text-muted-foreground">
        Each workspace creates its own scoped API keys and calls <code>{'/v1/{account}/...'}</code>. Gateway checks the
        key, forwards the call with one upstream bearer token, and records it. Your upstream stays private, your users
        never see its credential, and you get logs, usage, a playground and an API reference without building them.
      </p>
      <div className="mt-7 mb-4 flex flex-wrap gap-3">
        <Button asChild size="lg" className="px-5">
          <a href="#tutorial">Get started</a>
        </Button>
        <Button asChild variant="outline" size="lg" className="px-5">
          <a href={GETTING_STARTED}>Read the docs</a>
        </Button>
      </div>
      <p className="max-w-[46rem] text-sm text-muted-foreground">
        <strong>Not affiliated.</strong> This project is unofficial and is not affiliated with, endorsed by or connected
        to any content platform or its operators. You are responsible for complying with the terms of the platforms you
        use. Free software under the <RepoLink path="LICENSE">AGPL-3.0-only</RepoLink> licence.
      </p>
      <Screenshot
        name="home"
        alt="The Gateway dashboard home page: requests, error rate and active keys for the last 24 hours"
        className="mt-10 shadow-[0_12px_40px_rgba(0,0,0,.12)]"
      />
    </section>
  );
}

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-card px-5 py-[18px] text-card-foreground shadow-xs ring-1 ring-foreground/10">
      <h3 className="mb-1.5 text-lg font-semibold">{title}</h3>
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}

function Features() {
  return (
    <Section
      id="features"
      title="What you get"
      intro="Everything between your users and the upstream, ready on first start."
    >
      <div className="mt-7 grid gap-5 md:grid-cols-3">
        <Feature title="Scoped API keys">
          <code>gk_</code> keys, shown once and stored as SHA-256 hashes. A <code>read</code> key may only{' '}
          <code>GET</code> and <code>HEAD</code>, a <code>write</code> key any method, and each key can be limited to a
          list of accounts. Changes and revocation apply on the next request.
        </Feature>
        <Feature title="Proxy">
          <code>{'/v1/{account}/<path>'}</code> reaches the upstream with one bearer token your users never see. Status,{' '}
          <code>content-type</code>, <code>retry-after</code> and <code>x-ratelimit-*</code> come back as sent; a
          successful JSON body arrives as <code>{'{"data": …, "_meta": {}}'}</code>, errors unchanged. 120 requests a
          minute per key by default.
        </Feature>
        <Feature title="Logs with redaction">
          Every <code>/v1</code> request made with an API key, and the playground's calls, with status, latency, key and
          account. Credential headers are never stored and secret-looking fields are masked. Bodies are kept for failed
          requests, logs for 14 days.
        </Feature>
        <Feature title="Usage">
          Requests and errors per day, broken down by key, account or endpoint, with a CSV export.
        </Feature>
        <Feature title="Playground">
          Pick an operation and an account, edit parameters and body, send, and copy the curl. It uses your dashboard
          session, so no key is pasted into the browser.
        </Feature>
        <Feature title="Merged OpenAPI reference">
          <code>/openapi.json</code> holds Gateway's own routes plus the upstream's operations rewritten to{' '}
          <code>{'/v1/{account}/...'}</code>, and <code>/docs</code> renders it as an interactive reference.
        </Feature>
        <Feature title="Webhooks and live events">
          Signed deliveries to your HTTPS endpoints, with retries and redelivery. The same events stream over the{' '}
          <code>/v1/ws</code> WebSocket and into the dashboard's live feed.
        </Feature>
        <Feature title="Chat analytics">
          Backfill an account's chats and sales, then read reply time, reply SLA, openers, scripts, conversations and
          revenue, per account and per day.
        </Feature>
        <Feature title="Workspaces">
          Keys, logs and usage belong to one workspace. Sign-up is open, but a workspace reaches the upstream only after
          the operator links it, and every linked workspace sees every connected account: run one deployment per
          operator.
        </Feature>
      </div>
    </Section>
  );
}

function HowItFits() {
  return (
    <Section
      id="how-it-fits"
      title="How it fits"
      intro={
        <>
          Clients call Gateway with a <code>gk_</code> key. Gateway forwards <code>{'/v1/{account}/<path>'}</code> to
          the upstream's <code>{'/of/<path>'}</code> with <code>Authorization: Bearer $UPSTREAM_TOKEN</code> and never
          forwards the client's own credentials. The bundled upstream in <code>services/upstream</code> holds each
          account's session and proxy, and streams its events back over one WebSocket, which Gateway fans out to
          webhooks and <code>/v1/ws</code> clients. Any service that answers the same calls can replace it; the{' '}
          <RepoLink path="README.md#how-it-fits">README</RepoLink> lists the contract.
        </>
      }
    >
      <Pre className="mt-4 text-[0.95rem] leading-[1.3]">{DIAGRAM}</Pre>
    </Section>
  );
}

const FOOTER_LINKS: [label: string, path: string][] = [
  ['README', 'README.md'],
  ['Getting started', 'docs/getting-started.md'],
  ['Authentication', 'docs/authentication.md'],
  ['Webhooks', 'docs/webhooks.md'],
  ['Realtime', 'docs/realtime.md'],
  ['Analytics', 'docs/analytics.md'],
  ['Deploy guide', 'deploy/hostinger.md'],
  ['Changelog', 'CHANGELOG.md'],
  ['Security', 'SECURITY.md'],
  ['Contributing', 'CONTRIBUTING.md'],
  ['Licence', 'LICENSE'],
];

function Footer() {
  return (
    <footer className="border-t pt-8 pb-12 text-sm text-muted-foreground">
      <nav className="mb-3 flex flex-wrap gap-x-[18px] gap-y-1.5" aria-label="Documentation">
        {FOOTER_LINKS.map(([label, path]) => (
          <a key={path} href={repoUrl(path)} className="underline-offset-4 hover:text-foreground hover:underline">
            {label}
          </a>
        ))}
      </nav>
      <p>
        Gateway is free software under the AGPL-3.0-only licence. If you run a modified version as a service that others
        use over a network, you must offer those users the source of your version.
      </p>
    </footer>
  );
}

const DIAGRAM = ` client (curl, script, browser)
        │  HTTPS · Authorization: Bearer gk_... · REST and /v1/ws
        ▼
 ┌──────────────┐  http   ┌────────────────────────┐  Bearer UPSTREAM_TOKEN  ┌────────────────────────┐
 │ Caddy (TLS)  │───────▶ │ Gateway :4000          │───────────────────────▶ │ upstream :8000         │
 └──────────────┘         │ API + dashboard        │◀──── events (/ws) ──────│ services/upstream      │
                          │ webhooks, /v1/ws       │                         │ OF sessions, proxies   │
                          └───────────┬────────────┘                         └───────────┬────────────┘
                                      │                                                  │ one proxy
                          ┌───────────▼────────────┐                                     │ per account
                          │ Postgres 17            │                                     ▼
                          │ keys, sessions, logs,  │                                     OF
                          │ event ledger           │
                          └────────────────────────┘`;
