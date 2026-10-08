# Testing on localhost, then against one real creator account

A runbook for the owner. It uses only what the repo already has. Sources: README, `docs/getting-started.md`,
`docs/analytics*.md`, `deploy/hostinger.md`, CHANGELOG and the step 0 reports in `/tmp/step0/`. "(check)" marks an
inference that no doc states outright.

Placeholders: `<id>` is the OF account id from `GET /v1/accounts`. `<teamId>` is the workspace id that `link-team`
prints. `<slug>` is the workspace slug from **Settings**.

## 1. Prerequisites

| Need | Version / where |
|---|---|
| Node | 22.12 or newer (`engines` in `package.json`) |
| pnpm | 10 (`packageManager: pnpm@10.33.2`) |
| Docker | Runs Postgres 17 and the real upstream (`services/upstream`, compose profile `upstream`) |
| Python venv for upstream gates | `~/.cache/gateway-upstream-venv` (Python 3.12, has `python`, `ruff`, `pytest`, `uvicorn`). Do not use anaconda `python`: it lacks `curl_cffi` (pass3 report) |
| Chrome + an OF creator login | Used to copy a DevTools cURL for the account. The optional Fastt Login Capture extension is detected by the Connect dialog |
| Proxy for the account | Optional. `OF_REQUIRE_PROXY` defaults to `false`, so without a proxy the account connects from your own IP |

Variables in the root `.env`. Copy it from `.env.example` and do not commit it. The API exits with a list of problems if a required one is missing.

| Variable | What it is for | Where to get it |
|---|---|---|
| `DATABASE_URL`, `TEST_DATABASE_URL` | Gateway DB and the vitest DB (`TEST_…` is read from the shell only, not `.env`) | `.env.example` defaults point at compose Postgres :5434 |
| `BETTER_AUTH_SECRET` | Session signing | `openssl rand -base64 32` |
| `APP_URL`, `BETTER_AUTH_URL` | Dashboard origin (the only Origin allowed on cookie writes) and the API's auth base | Set `APP_URL` to the dashboard's real port. Vite moves to :5174 when :5173 is taken (check) |
| `UPSTREAM_URL`, `UPSTREAM_TOKEN` | Where the gateway forwards and the bearer it sends | `http://localhost:3001`. The token must equal the one the upstream container gets (compose reads `UPSTREAM_TOKEN` from the shell or root `.env`) |
| `UPSTREAM_WS_URL` | Event source for webhooks, the live events card and `/v1/ws` | `ws://localhost:3001/ws`. Empty means no events, and `/v1/ws` answers 503 |
| `STATIC_PARAM` | OF signing parameter, read by the upstream (or pass `--static-param` to `connect.py`) | Whoever ran the upstream before (check) |
| `OF_REQUIRE_PROXY` | `true` refuses accounts that have no proxy | Default `false` |
| `ALLOW_HTTP_WEBHOOKS` | Allows the local `http://localhost:4100` webhook receiver | Set `true` for local tests only |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` | Verification email. With no `SMTP_HOST`, the link is printed in the API log | Your mail provider |
| `ANALYTICS_REQUESTS_PER_HOUR`, `ANALYTICS_PAGE_DELAY_MS`, `ANALYTICS_BACKOFF_MAX_MS` | Backfill pacing | Keep the defaults: 600, 300, 300000 |
| `KEY_RATE_LIMIT_PER_MIN`, `LOG_BODIES`, `RUN_JOBS` | Per-key limit (120), body logging (`errors`), retention jobs and the webhook worker (`true`) | Defaults |

## 2. Bring-up on localhost

```sh
cd ~/gateway
pnpm install
docker compose up -d                                         # 1. Postgres 17 on 127.0.0.1:5434 (+ gateway_test DB)
docker compose --profile upstream up -d --build upstream     # 2. real upstream on 127.0.0.1:3001 (rebuild: backfill needs settings/welcome-message)
pnpm db:migrate                                              # 3. prints "migrations applied"; 0000..0011
pnpm dev                                                     # 4. API :4000 + dashboard (Vite) :5173 or :5174
```

Health checks:

| Component | Command | Healthy when |
|---|---|---|
| Postgres | `docker compose ps postgres` | `healthy` (`pg_isready` healthcheck) |
| Migrations | `docker compose exec -T postgres psql -U gateway -d gateway -c 'select count(*) from drizzle.__drizzle_migrations'` | 12 rows (live-checks-v2) |
| Upstream | `curl -fsS http://127.0.0.1:3001/healthz` | 200, the same probe as the image HEALTHCHECK |
| API | `curl -fsS http://localhost:4000/healthz` | `{"ok":true}` |
| Merged spec | `curl -sI http://localhost:4000/openapi.json` | 200 with no `x-upstream-spec: unavailable` header |
| Dashboard | Open the URL Vite prints | Login page. Writes fail with a CSRF error if `APP_URL` is not this origin (check) |

To run without OF, run `UPSTREAM_TOKEN=dev-upstream-token pnpm --filter @gateway/api exec tsx test/fake-upstream.ts`
instead of step 2. It serves account `1` on :3001. Use one upstream or the other, not both.

## 3. Automated gates

| Gate | Command (repo root unless noted) | Expected |
|---|---|---|
| Typecheck | `pnpm -r typecheck` | exit 0 |
| API tests | `pnpm --filter @gateway/api test` | 23 files, 304 passed (needs Postgres up) |
| Web tests | `pnpm --filter @gateway/web test` | 4 files, 23 passed |
| Secrets | `sh scripts/check-secrets.sh --all` | exit 0 |
| Upstream tests | `cd services/upstream && UPSTREAM_TOKEN=test-token-at-least-16-chars UPSTREAM_STATE_DIR=$(mktemp -d) ~/.cache/gateway-upstream-venv/bin/python -m pytest -q` | 507 passed (pass3) |
| Upstream lint | `cd services/upstream && ~/.cache/gateway-upstream-venv/bin/ruff check .` | clean |
| Parity dump | `cd services/upstream && UPSTREAM_TOKEN=test-token-at-least-16-chars UPSTREAM_STATE_DIR=$(mktemp -d) ~/.cache/gateway-upstream-venv/bin/python -c 'import json, app; print(json.dumps(app.app.openapi()))' > /tmp/up.json` | file written |
| Parity check | `node scripts/parity-audit.mjs check /tmp/up.json` | exit 0, 113/233 per-account lines served, no regression, no off-spec |
| Drizzle drift | `pnpm db:generate` | no new file in `apps/api/drizzle` |
| Optional: image smoke | `sh scripts/compose-smoke.sh` | passes (CI `docker` job) |

## 4. Connect one real model

1. **Sign up.** Open the dashboard and register. Open the verification link, which is in the API log when there is no SMTP. A
   workspace is created.
2. **Link the workspace.** Copy `<slug>` from **Settings**, then run `pnpm --filter @gateway/api link-team <slug>`. It prints
   `linked workspace <slug> (<teamId>)`. Note `<teamId>` for later.
3. **Copy the session.** Log in to OF in Chrome and open DevTools → Network. Right-click a request to `onlyfans.com/api2/v2/…`
   (e.g. `users/me`) and choose Copy as cURL (bash). It must carry `-b '…'` cookies and a `user-id` header.
4. **Connect.** Use **Accounts → Connect account**: paste the cURL, a nickname, and optionally a proxy URL
   (`socks5h://user:pass@host:port` or `http://…`). Leave the proxy empty to use your own IP (`OF_REQUIRE_PROXY=false`).
   The CLI does the same:
   `umask 077; pbpaste > /tmp/curl.txt; docker compose exec -T upstream python connect.py --nickname Main [--proxy-url …] < /tmp/curl.txt; rm /tmp/curl.txt`.
   It prints `{"accountId", "username", "status"}`.
5. **Check the status.** Reload **Accounts** and look for `active` or `connecting`. `no_session` or `session_expired` means you
   need to capture again. `no_proxy` appears only with `OF_REQUIRE_PROXY=true`.
6. **Mint two keys.** Go to **API keys**. The secret is shown once.
   - `read` key, allowlist `[<id>]`, named `testing-read`
   - `write` key, allowlist `[<id>]`, named `testing-write`. This live key, with an allowlist naming the account, is the
     backfill precondition.
7. **Store the keys** in an editor so they stay out of shell history: `mkdir -p /tmp/step0 && umask 077 && nano /tmp/step0/.keys`, with
   `READ=gk_…`, `WRITE=gk_…`, `READ_ID=key_…` and `WRITE_ID=key_…`. Then run `chmod 600 /tmp/step0/.keys`. Load them per shell with
   `set -a; . /tmp/step0/.keys; set +a`. `/tmp/step0/mint.mts` (scratch, not in the repo) mints read keys through
   `createKey`. It hardcodes old workspace ids, so edit it before use and run it from `apps/api` with
   `npx tsx --env-file-if-exists=../../.env` (check).
8. **Smoke.** `curl -H "Authorization: Bearer $READ" localhost:4000/v1/whoami` should show the scope and allowlist.
   `curl -H "Authorization: Bearer $READ" localhost:4000/v1/accounts` should list `<id>`.
9. **Claim for analytics.** `pnpm --filter @gateway/api analytics:claim --team <teamId> --account <id>`. It is idempotent. A
   different workspace whose keys name the account gets `account_workspace_conflict`.
10. **Second workspace, for the isolation tests.** Register a second user, link its workspace and mint a `read` key with no
    allowlist. Store it as `ISO=gk_…` in the same `.keys` file.

## 5. Feature test matrix

Use `H="Authorization: Bearer $READ"` and base `localhost:4000`. "Verified" means the expected result was seen against the real account.

| Feature | How to exercise | Expected | Verified means | Known gaps |
|---|---|---|---|---|
| Proxy, named reads | `curl -H "$H" …/v1/<id>/me`, `…/chats?limit=10`, `…/settings/welcome-message` | Upstream status and body unchanged, `x-request-id` present | 200 with real data on each | v2.1 GETs marked "verified on one account" have only a probe as evidence |
| Proxy, raw passthrough | `…/v1/<id>/_of/<OF path>` | OF's own shape | 200 on one known OF path | none recorded |
| Proxy, writes | Only `[W]` rows you can undo, with `$WRITE` | 2xx, and the effect is visible in OF | Effect seen in OF and undone | Every v2.1 write is fixture-tested only and has never been executed against OF. Unmapped fields give `422 unsupported_field` |
| Scopes and allowlist | `$READ` with `POST`; `$READ` on another account id | `403 insufficient_scope`; `403 account_not_allowed` | Both errors seen | none recorded |
| Rate limit | More than 120 req/min on one key | `429 rate_limited` | 429 seen | none recorded |
| Logs and usage | Dashboard **Logs** and **Usage** after the calls above | Rows with status, latency, key and account. No credential headers stored | Your calls appear, redacted | none recorded |
| Playground | Dashboard `/playground`, pick an op and the account, Send | `limit` 20 and last-7-days dates prefilled, Table view, Copy curl | Real response rendered | `pnpm media` (screenshot script) Playground selector is broken (earlier session notes). The Playground itself is not affected |
| OpenAPI and docs | `GET /openapi.json`, `/docs` | Gateway plus upstream ops under `platform` | Upstream ops present | Spec is cached 10 min |
| Email verification | Sign up a new user | `403 EMAIL_NOT_VERIFIED` until the link is opened. Login page has Resend | Real email received with `SMTP_*` set | Live SMTP send untested |
| Webhooks | Set `ALLOW_HTTP_WEBHOOKS=true`. Run `WEBHOOK_SECRET=whsec_… pnpm --filter @gateway/api exec tsx src/db/webhook-receiver.ts` (:4100). Create an endpoint `http://localhost:4100/hook` with `$WRITE`, then `POST /v1/webhooks/$ID/test` | Receiver logs `signature ok`, delivery `succeeded` | A real OF event (e.g. a fan message) delivered | `$WRITE` is allowlisted, and any allowlisted key gets `403 account_not_allowed` on webhook routes. Create the endpoint from the dashboard (session) or with an un-allowlisted write key (check). Events are at-most-once and lost during reconnects. `upstream.*` names may change |
| Webhook SSE and live events | Dashboard **Webhooks**: Live events card, **Emit test event** button | Toast per delivery attempt, `webhook.test` in the card, desktop notification when the tab is hidden | Real event from the account shows in the card | Stream lives 10 min, then the browser reconnects (check) |
| Realtime `/v1/ws` | `node -e "const w=new WebSocket('ws://localhost:4000/v1/ws?accountId=<id>',['bearer','bearer.'+process.env.READ]);w.onmessage=m=>console.log(m.data)"` | `ready` frame, then events | A real event frame | 503 when `UPSTREAM_WS_URL` is empty |
| Event stats | `GET /v1/stats?from=…&to=…` | Per-day, per-account, per-type counts from the event ledger | Counts match events seen | Needs events flowing |
| Backfill, step 0 | §6.1 | Prints requests, unmatched queue ids and incomplete chats, then four CSVs | Runs to `stopped: no` | Quiet-page miss: an active chat listed after 2 quiet pages is missed. Earnings and transactions endpoints ignore the date range (all-time). 6306 unmatched queue ids on the 30-day run (overnight report) |
| Backfill `--dry-run` | Add `--dry-run --out <new dir>` | Same requests, nothing stored | 0 new rows (SELECT before and after) | `--team` unchecked in a dry run |
| Stats metrics | `GET /v1/stats/metrics`, then `/v1/stats/metrics/reply_time?from=…&to=…&groupBy=day\|hour\|account` and `/samples` | 200, `verified:false`, `asOf`, `configVersion` | Numbers consistent (turns = inCap + late + breached + pending) | All metrics unverified |
| CSV export | `…/v1/stats/metrics/reply_time?format=csv&groupBy=hour` | `text/csv`, 24 data rows by hour | Header matches docs | none recorded |
| Stats config | `GET /v1/stats/config`. `PUT` with `$WRITE` `{"slaSeconds":600}`. `PUT` with `$READ` | Defaults, then `version`+1, then `403 insufficient_scope` | All three seen. Put the value back afterwards | `convertSeconds` is stored only |
| Stats scripts | `GET /v1/stats/scripts?from=…&to=…` | Items with `sends`, `sendsAll`, `chatsAll`, variants | Matches the scripts CLI | Variants keep raw `<p>` HTML. Every script is `origin: auto` |
| Stats errors and isolation | `from=2026-13-01`. Then every stats route with `$ISO`, including `accountId=<id>` | `400 validation_error`. Empty rows/items for `$ISO` | Zero matches for `<id>` in the `$ISO` output | none recorded |
| Openers CLI | `pnpm --filter @gateway/api analytics:openers --account <id> --from <d> --to <d> --out /tmp/step0/openers-samples.md` | `openers N, listed ≤20` | Morning check OK (§6.2) | Unverified |
| Scripts CLI | `… analytics:scripts … --out /tmp/step0/scripts-top20.md` | `scripts N, listed ≤20` | Morning check OK | Unverified |
| Rehash | `pnpm --filter @gateway/api analytics:rehash --account <id>` | `normaliser v1: outbound N, updated M, scripts K`. A second run shows `updated 0` | Idempotent | Fan names are only used after a post-0010 re-walk |
| Diff | `pnpm --filter @gateway/api analytics:diff --ours <dir> --infloww <file.csv> [--tz +02:00]` | Mapping, per-row lines, summary. Exits 0 | Every row explained or unresolved | Waits on the client's export |
| Owner captures | `docs/spec/plan-v6-capture-kit.md`, into `~/of-captures/` | cURL per `?` row | 72 rows captured | Files hold live cookies. Not in this runbook's scope |

## 6. Analytics acceptance against the real model

1. **30-day backfill.** `--to` is exclusive, so tomorrow includes today. Leave the pacing variables unset (600/h cap):
   ```sh
   pnpm --filter @gateway/api analytics:backfill --account <id> --from <today-30d> --to <tomorrow> --out /tmp/step0/last30-<date>
   ```
   The reference run (2026-09-06..10-06) took 259 requests in 12 min, with 87 chats, 9150 messages, 1286 turns and 7 incomplete chats.
   Leave an hour before the next run: each run counts its cap from zero. Ctrl-C stops the run and still writes CSVs.
2. **Morning check.** Run the openers and scripts CLIs over the same range (§5). Log in to OF and check every row per
   `docs/analytics.md` "Morning checklist". Write the verdict, OK or wrong for each row with its chat id, message id and what OF shows,
   to `/tmp/step0/morning-verdict.md`. The earlier passes looked for that file (check).
3. **Infloww diff, when the CSV arrives.** Ask for the Message Dashboard export: one creator, one past week, report tz UTC+0, plus Sales
   Records for the same week. Export the `.xlsx` sheet to CSV (UTF-8). Backfill exactly that week to its own `--out` dir, then
   run `analytics:diff --ours <that dir> --infloww <csv>`. `/tmp/step0/presh.xlsx` is an earlier export. It is not
   for this account's week (check).
4. **Completeness (spec 6.1) re-run.** Run `analytics:backfill … --from <today-7d> --to <tomorrow> --dry-run --out /tmp/step0/dryrun-<date>`.
   Compare its `messages.csv` per chat with stored `message_fact` for the same range. The pass used the scratch
   `/tmp/step0/compare7.mjs` (not in the repo). Every difference needs an explanation: late arrival, fan deletion, or the
   quiet-page miss. Check that the `lastMessage: null` chat is now walked, because the fix was never re-run live. For transactions, compare
   the `transactions.csv` total with OF's statements for the same days. Upstream earnings ignore the range, so filter by date yourself.
5. **Second-workspace check.** Use `$ISO` on every stats route, as in §5. Acceptance: it sees none of `<id>`.
6. **Flipping `verified`.** This is a developer task. Today one constant `verified: false` covers every metric in
   `apps/api/src/modules/analytics/metrics.ts`, so per-metric flags need a code change. Flip openers and scripts only after
   step 2 is all OK, and `reply_time_mean` and `reply_time_mean_last` only after step 3 explains every difference.
7. **Rate cap.** Keep `ANALYTICS_REQUESTS_PER_HOUR=600` (the default, which is a guess). Run one account at a time, with an hour between runs.

## 7. Teardown

1. **Keys.** List them, then revoke in **API keys** or delete by id, then confirm with the same query:
   ```sh
   docker compose exec -T postgres psql -U gateway -d gateway -c "select id, name, scope, allowed_account_ids, revoked_at from api_key"
   docker compose exec -T postgres psql -U gateway -d gateway -c "delete from api_key where id in ('<READ_ID>','<WRITE_ID>')"
   ```
   Pass3 left a `live-check` write key, allowlisted to the account, live. Decide whether to delete it.
   Delete the second workspace's organization row (FK cascade removes its key and `stats_config`). Then `rm /tmp/step0/.keys`.
2. **Scratch files with fan ids.** `/tmp/step0/` holds CSVs, md and json with fan ids and message text. Also check
   `/tmp/up.json`, `/tmp/have.txt` and `/tmp/up-live.json`. `~/of-captures/` holds session cookies. Delete what you
   do not need to keep.
3. **Webhook endpoint.** `DELETE /v1/webhooks/$ID`, then stop the receiver.
4. **Stop.** Ctrl-C `pnpm dev`, then `docker compose --profile upstream stop`. Do not run `down -v`: it deletes the DB and
   the upstream volume with the account's session and proxy.
5. **OF session.** Logging out of OF invalidates the copied cookies. If the connected session came from that browser
   login, the account goes to `session_expired` (check).

## 8. Open questions for the owner

1. Use the account and workspace that are already claimed, or a fresh workspace and account? An account can belong to only one workspace.
2. Proxy or no proxy for the real account? The default is no proxy, so it uses your IP.
3. Which `[W]` writes may be run against the real account? None have ever been executed against OF.
4. When will the Infloww Message Dashboard export (one week, UTC+0) and Sales Records arrive?
5. Who does the morning check in OF, and by when?
6. Does the client have automation texts for `--automation <file>`?
7. Keep or delete the pre-existing `live-check` write key?
8. Should a live SMTP send be tested with a real inbox now?
