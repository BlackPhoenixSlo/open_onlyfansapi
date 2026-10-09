import type { ReactNode } from 'react';
import { Pre, RepoLink, Section } from './ui';

/** A numbered step; the number comes from the list's `step` counter. */
function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="relative mb-11 space-y-4 [counter-increment:step] before:mb-2.5 before:grid before:size-9 before:place-items-center before:rounded-full before:bg-primary before:font-bold before:text-primary-foreground before:content-[counter(step)] md:pl-14 md:before:absolute md:before:-top-0.5 md:before:left-0 md:before:mb-0 [&>p]:max-w-[48rem] [&>ul]:max-w-[48rem]">
      <h3 className="text-lg font-semibold">{title}</h3>
      {children}
    </li>
  );
}

function Subheading({ children }: { children: ReactNode }) {
  return <h4 className="pt-1.5 font-semibold">{children}</h4>;
}

export function Tutorial() {
  return (
    <Section
      id="tutorial"
      title="Tutorial: from zero to your first call"
      intro={
        <>
          The commands below come from <RepoLink path="docs/getting-started.md">getting-started.md</RepoLink> and the{' '}
          <RepoLink path="deploy/hostinger.md">deploy guide</RepoLink>. Locally the API is on{' '}
          <code>http://localhost:4000</code> and the dashboard on <code>http://localhost:5173</code>; on a VPS both are
          your <code>PUBLIC_URL</code>.
        </>
      }
    >
      <ol className="mt-8 [counter-reset:step]">
        <Step title="Run it">
          <Subheading>Locally</Subheading>
          <p>
            You need Node 22.12 or newer, pnpm 10 and Docker. For <code>BETTER_AUTH_SECRET</code>,{' '}
            <code>openssl rand -base64 32</code> works; <code>.env.example</code> fills in the rest for local use.
          </p>
          <Pre>{RUN_LOCALLY}</Pre>
          <p>
            Then start an upstream on port 3001 (the default <code>UPSTREAM_URL</code>) in a second terminal. The fake
            one the tests use needs no real account and serves one account with id <code>1</code>; the bundled one in{' '}
            <code>services/upstream</code> talks to the platform:
          </p>
          <Pre>{START_UPSTREAM}</Pre>
          <p>
            For events (webhooks, <code>/v1/ws</code>, live stats), add <code>UPSTREAM_WS_URL=ws://localhost:3001/ws</code>{' '}
            to <code>.env</code> and restart <code>pnpm dev</code>. Both upstreams serve it.
          </p>
          <Subheading>On a VPS</Subheading>
          <p>
            You need a Docker VPS with 2 GB RAM or more, a DNS record for your hostname, and ports 80 and 443 open. Fill
            in four values in <code>deploy/.env</code>: <code>PUBLIC_URL</code> (your <code>https://</code> hostname, no
            trailing slash), <code>POSTGRES_PASSWORD</code> (<code>openssl rand -hex 24</code>),{' '}
            <code>BETTER_AUTH_SECRET</code> (<code>openssl rand -base64 32</code>) and <code>UPSTREAM_TOKEN</code> (
            <code>openssl rand -hex 32</code>; letters, digits and <code>-._~</code> only). The rest defaults to the
            bundled upstream. Set <code>STATIC_PARAM</code>, OF's static signing parameter, there too, or pass it per
            account when you connect one (step 3).
          </p>
          <Pre>{RUN_ON_VPS}</Pre>
          <p>
            The first run builds the images and takes a few minutes. Migrations run on every start and Caddy fetches a
            certificate on first boot. The deploy guide also covers updates, backups, the firewall and running behind a
            Cloudflare Tunnel.
          </p>
        </Step>
        <Step title="Sign up and get your workspace linked">
          <p>
            Open the dashboard and register, then open the verification link from your email. Without SMTP the link is
            printed in the API log (<code>docker compose logs gateway</code> on a VPS). This creates your workspace.
            Until the operator links it, calls that would reach the upstream fail with <code>409 team_not_linked</code>.
            Copy the workspace slug from <strong>Settings</strong>, then link it:
          </p>
          <Pre>{LINK_TEAM}</Pre>
          <p>
            Running it again is harmless. Link only workspaces you trust: every linked workspace sees every connected
            account.
          </p>
        </Step>
        <Step title="Connect an account">
          <p>
            With the fake upstream, account <code>1</code> is already there; skip to step 4. Otherwise copy a cURL from
            Chrome: DevTools → Network → a request to <code>onlyfans.com/api2/v2/…</code> → Copy as cURL (bash). It must
            carry the cookies as <code>-b '…'</code>. On <strong>Accounts</strong>, press{' '}
            <strong>Connect account</strong>, paste it, add a nickname if you like, and a proxy URL for that account (
            <code>http://user:pass@host:port</code> or <code>socks5h://…</code>; without one the account connects from
            the server's own IP). OpenOnlyfansAPI hands the cURL to the upstream and never stores it in the request log. Or
            connect from the shell:
          </p>
          <Pre>{CONNECT_FROM_SHELL}</Pre>
          <p>
            Either way, the upstream needs OF's static signing parameter: <code>STATIC_PARAM</code> in its environment (
            <code>deploy/.env</code> on a VPS, applied by <code>docker compose up -d</code>; locally{' '}
            <code>STATIC_PARAM=… docker compose --profile upstream up -d upstream</code>), or{' '}
            <code>{'--static-param <value>'}</code> added to the shell command.
          </p>
          <p>
            The account then shows up on <strong>Accounts</strong> with its status. A <code>session_expired</code>{' '}
            account needs a fresh cURL.
          </p>
        </Step>
        <Step title="Create an API key">
          <p>
            On <strong>API keys</strong>, press <strong>Create key</strong> and give it a name, a scope and, if you like,
            a list of allowed account ids (empty means every account). See{' '}
            <RepoLink path="docs/authentication.md">authentication.md</RepoLink> for the details.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <code>read</code> allows <code>GET</code> and <code>HEAD</code> only; anything else gets{' '}
              <code>403 insufficient_scope</code>.
            </li>
            <li>
              <code>write</code> allows every method.
            </li>
            <li>
              Each key may make 120 requests a minute (<code>KEY_RATE_LIMIT_PER_MIN</code>); over that you get{' '}
              <code>429 rate_limited</code>.
            </li>
          </ul>
          <p>The secret is shown once, so copy it now:</p>
          <Pre>{'export API_KEY=gk_...'}</Pre>
        </Step>
        <Step title="Make your first call">
          <Pre>{FIRST_CALL}</Pre>
          <p>
            <code>/v1/whoami</code> shows the workspace, the key's scope and its allowlist; <code>/v1/accounts</code>{' '}
            lists the accounts the key may use. Anything under <code>{'/v1/{account}/'}</code> is forwarded to the
            upstream for that account. A successful JSON answer comes back wrapped in{' '}
            <code>{'{"data": …, "_meta": {}}'}</code>, plus <code>{'"_pagination": {"next_page": …}'}</code> when there
            is a next page; the upstream's errors come back unchanged. OpenOnlyfansAPI's own errors look like{' '}
            <code>{'{ "error": { "code": "...", "message": "...", "requestId": "req_..." } }'}</code>, and every response
            carries an <code>x-request-id</code> header.
          </p>
        </Step>
        <Step title="Try the playground">
          <p>
            Open <strong>Playground</strong>, pick an operation and an account, fill in the parameters and body, and
            press <strong>Send</strong>. It runs on your dashboard session, so no key is needed in the browser, and its
            account calls are logged with the key "Dashboard". Copy the curl snippet (it uses <code>$API_KEY</code>) when
            you want the same call in a script. The full reference is at <code>/docs</code>, and the spec at{' '}
            <code>/openapi.json</code>; neither needs a login.
          </p>
        </Step>
        <Step title="Read logs and usage">
          <p>
            <strong>Logs</strong> lists the <code>/v1</code> requests made with an API key and the playground's calls
            (not the dashboard's own polling); open a row for its headers and bodies, or{' '}
            <strong>Open in playground</strong> to send it again. <strong>Usage</strong> charts requests and errors per
            day by key, account or endpoint. Bodies are stored only for failed requests (status 400 and up) unless you
            set <code>LOG_BODIES</code> to <code>all</code> or <code>none</code>, and logs are kept for{' '}
            <code>LOG_RETENTION_DAYS</code> days (14). Set them in <code>.env</code>; on a VPS, add them to the gateway
            service's <code>environment</code> in <code>deploy/docker-compose.yml</code>, which lists its variables one
            by one.
          </p>
        </Step>
        <Step title="Subscribe to webhooks and live events">
          <p>
            Events come from the upstream's event socket, <code>UPSTREAM_WS_URL</code> (the deploy <code>.env</code>{' '}
            already points it at the bundled upstream). On <strong>Webhooks</strong>, press{' '}
            <strong>Add endpoint</strong>, enter an <code>https://</code> URL and the events you want (none means every
            event), then <strong>Send test event</strong>. The <strong>Live events</strong> card shows events as they
            arrive, whether or not an endpoint gets them. Or create the endpoint with a <code>write</code> key (keys
            limited to some accounts get <code>403 account_not_allowed</code> on webhook routes):
          </p>
          <Pre>{CREATE_WEBHOOK}</Pre>
          <p>
            Each delivery is a <code>POST</code> of <code>{'{"event", "account_id", "payload"}'}</code> with a{' '}
            <code>Signature</code> header, the hex HMAC-SHA256 of the raw body keyed with the endpoint's{' '}
            <code>whsec_...</code> secret, and an <code>X-OFAPI-Idempotency-Key</code> to drop duplicates on. Failed
            attempts are retried after 30 s, 2 m, 10 m, 1 h and 6 h, and an endpoint that keeps failing is paused.{' '}
            <RepoLink path="docs/webhooks.md">webhooks.md</RepoLink> has the event list and verification code for Node
            and Python. To try it locally, set <code>ALLOW_HTTP_WEBHOOKS=true</code> in <code>.env</code> (otherwise
            only <code>https://</code> public hosts are accepted), run{' '}
            <code>WEBHOOK_SECRET=whsec_... pnpm --filter @gateway/api exec tsx src/db/webhook-receiver.ts</code> and
            point an endpoint at <code>http://localhost:4100/hook</code>; it logs "signature ok" for each delivery.
          </p>
          <p>
            To get the same events over a socket instead, connect to <code>/v1/ws</code> (
            <RepoLink path="docs/realtime.md">realtime.md</RepoLink>). In a browser, use a <code>read</code> key limited
            to the accounts the page needs:
          </p>
          <Pre>{WEBSOCKET}</Pre>
        </Step>
        <Step title="Run analytics and read the stats">
          <p>
            This needs a real, active account. On <strong>Accounts</strong>, pick 30, 90 or 180 days and press{' '}
            <strong>Run analytics</strong>. OpenOnlyfansAPI claims the account for your workspace and reads its chats, messages
            and transactions through the upstream in the background; the row shows{' '}
            <em>Running… N chats, M messages</em>, then <em>Done · view Stats</em>. Long ranges take hours at the
            per-hour request cap, one account runs at a time, and restarting the API ends a run in flight (the rows
            already stored stay).
          </p>
          <p>
            Then read <strong>Stats</strong> (reply time, SLA, openers, scripts, fans), <strong>Conversations</strong>{' '}
            (each fan's thread, with CSV export) and <strong>Revenue</strong>. The same data is on the API:
          </p>
          <Pre>{STATS_API}</Pre>
          <p>
            Live <code>messages.received</code>, <code>messages.sent</code> and <code>messages.deleted</code> events keep
            the stored messages current between runs. Set <code>STATS_REFRESH_HOUR_UTC</code> (0 to 23) for a daily
            refresh of each claimed account and an hourly poll of recent sales: in <code>.env</code> locally; on a VPS,
            add it to the gateway service's <code>environment</code> in <code>deploy/docker-compose.yml</code> and run{' '}
            <code>docker compose up -d</code> to recreate the container. See{' '}
            <RepoLink path="docs/analytics-backfill.md">analytics-backfill.md</RepoLink> for the command-line backfill
            and <RepoLink path="docs/analytics.md">analytics.md</RepoLink> for every metric's formula.
          </p>
          <p className="text-sm text-muted-foreground">
            Every metric is marked <code>verified: false</code>: the formulas are built and tested, but not yet checked
            by hand against the platform or another tool's export.
          </p>
        </Step>
      </ol>
    </Section>
  );
}

const RUN_LOCALLY = `pnpm install
docker compose up -d     # Postgres 17 on 127.0.0.1:5434, plus a gateway_test database
cp .env.example .env     # set BETTER_AUTH_SECRET, and UPSTREAM_TOKEN=dev-upstream-token
pnpm db:migrate
pnpm dev                 # API on http://localhost:4000, dashboard on http://localhost:5173`;

const START_UPSTREAM = `UPSTREAM_TOKEN=dev-upstream-token pnpm --filter @gateway/api exec tsx test/fake-upstream.ts
# or, for real accounts:
docker compose --profile upstream up -d --build upstream`;

const RUN_ON_VPS = `git clone https://github.com/BlackPhoenixSlo/gateway.git /opt/gateway
cd /opt/gateway/deploy
cp .env.example .env && chmod 600 .env
docker compose up -d
curl -fsS https://gw.example.com/healthz`;

const LINK_TEAM = `pnpm --filter @gateway/api link-team <workspace-slug>                    # locally
docker compose exec gateway node dist/db/link-team.js <workspace-slug>   # on the VPS, from /opt/gateway/deploy`;

const CONNECT_FROM_SHELL = `docker compose exec -T upstream python connect.py --nickname Main --proxy-url socks5h://user:pass@host:port < curl.txt`;

const FIRST_CALL = `curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/v1/whoami
curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/v1/accounts
export ACCOUNT_ID=123    # an id from /v1/accounts (1 with the fake upstream)
curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/v1/$ACCOUNT_ID/me
# {"data": { ...the upstream's body... }, "_meta": {}}`;

const CREATE_WEBHOOK = `curl -X POST http://localhost:4000/v1/webhooks \\
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \\
  -d '{"url": "https://example.com/hook", "events": ["messages.received", "messages.sent"]}'
curl -X POST http://localhost:4000/v1/webhooks/$ID/test -H "Authorization: Bearer $API_KEY"   # $ID from the response`;

const WEBSOCKET = `const ws = new WebSocket('wss://gw.example.com/v1/ws', ['bearer', 'bearer.' + apiKey]);
ws.onmessage = (m) => console.log(JSON.parse(m.data));
// {"event":"messages.received","account_id":"1001","payload":{...}}`;

const STATS_API = `curl -X POST http://localhost:4000/v1/stats/backfill \\
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \\
  -d '{"accountId": 123, "days": 30}'
curl -H "Authorization: Bearer $API_KEY" "http://localhost:4000/v1/stats/backfill?accountId=123"
curl -H "Authorization: Bearer $API_KEY" "http://localhost:4000/v1/stats/metrics/reply_time?groupBy=day"
curl -H "Authorization: Bearer $API_KEY" "http://localhost:4000/v1/stats/revenue?from=2026-09-01&to=2026-09-30"`;
