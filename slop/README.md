# slop/ — the repo's one real-path harness

`slop/run all` brings up the real stack on loopback (web via Vite, the TS API, the upstream, a fresh `gateway_slop`
database), drives each user flow through its real endpoints and UI, and asserts invariants. Everything outside the repo
is faked at its wire boundary by `lib/`, never inside service code. Extend this harness; do not fork it.

```
slop/run --list                         # scenarios and the faults each supports
slop/run all                            # every scenario; exit 0 = all green
slop/run browserbase-otp --fault otp-code-never-consumed   # break it once: only the targeted checks go red
slop/run otpstate-session-expired --fault otpstate-not-refused
```

Exit codes: 0 every check passed, 1 a check failed, 3 infra (the stack did not come up or the scenario crashed).
Needs Postgres at `127.0.0.1:5434` (user/password `gateway`, as in `docker-compose.yml`), the upstream venv at
`~/.cache/gateway-upstream-venv` (or `$SLOP_PY`) with Playwright's Chromium, and `pnpm install` done.

## Evidence

Every run writes `slop/runs/<UTC stamp>-<git short sha>-<scenario>[-fault-<name>]/` (git-ignored) and prints its name.
Quote runs by that name. Inside:

- `assertions.txt` / `assertions.json`: the verdict, git SHA (and whether the tree was dirty), each check and its detail
- `metrics.json`: timings, incl. `api_p95_ms` (each run compares itself with the last green run of its scenario)
- `upstream.log`, `api.log`, `web.log`, `migrate.log`, `fake-world.log`: every process's own output
- `api-calls.jsonl` (the probes' calls), `dashboard-responses.jsonl` (what the browser got from `/api` and `/v1`)
- `fake-of-otp-record.jsonl`: what "OnlyFans" received — the one file a 2FA code may appear in
- `fake-of-api-calls.jsonl` (every call the fake OF API answered, with status), `webhook-deliveries.jsonl` (every POST
  the fake receiver got), `ws-client-frames.jsonl` (every frame the `/v1/ws` clients got), where a scenario uses them
- `offhost-refused.jsonl`: every connection the guard refused (must stay empty)
- `screenshots/`

## Layout

| Path | What |
|---|---|
| `run`, `lib/cli.py` | entry point: picks scenarios, makes the run folder, records checks, exit code |
| `lib/stack.py` | `gateway_slop` drop/create/migrate, then upstream, API, web on free ports; all killed on exit |
| `lib/upstream_launcher.py` | runs the real upstream with the guard, OF/Browserbase base URLs pointed at the fakes, and `$SLOP_FAULT` |
| `lib/fake_world.py` | fake Browserbase API (one local headless Chromium per session over CDP), live view, OnlyFans site/API/socket |
| `lib/guard.py`, `lib/node_guard.cjs` | refuse (and log) any connection off loopback, in the Python and Node processes |
| `lib/vite.slop.config.mts` | the web app's own Vite config with its proxy pointed at the slop API (apps/web untouched) |
| `lib/recorder.py`, `lib/report.py` | recorded HTTP clients (dashboard user, API key); checks, metrics, verdict, p95 vs last green |
| `lib/seed.py` | SQL seeding before services start: workspaces, owners, keys, accounts, mass history; the upstream's session store |
| `lib/webhook_receiver.py` | loopback webhook receiver, registered through the real `POST /v1/webhooks`; records every delivery |
| `scenarios/<flow>.py` | one file per user flow: `async def run(ctx, out, fault)` and `FAULTS` |

## Declared fakes and bypasses

- **Browserbase** is a local HTTP fake in its `/v1` shapes; a session is a fresh local headless Chromium whose CDP URL is
  the `connectUrl`. Its live view is a page of CDP screenshots, not Browserbase's interactive devtools page.
- **OnlyFans' site** is served over HTTPS on loopback; the session Chromium maps `onlyfans.com` to it
  (`--host-resolver-rules`, everything else NOTFOUND) and accepts its self-signed certificate. Its 2FA page puts a
  hidden stale `input[name=code]` ahead of the real one; a wrong code re-renders the prompt with an error.
- **OnlyFans' API and socket** (used after the login by the capture pipeline and pollers) are loopback fakes; the upstream
  reaches them by IP via module constants set in the launcher, so its `.onlyfans.com` cookies are not sent there; the
  fake authenticates by the verified signature. The signing material is synthetic.
- **The guard** does not cover child processes of the upstream (Playwright's driver, Chromium); the session Chromium is
  confined by its resolver rules, and the driver only talks to it.
- **Nothing is seeded by SQL** in `browserbase-otp-login`: sign-up links the workspace and the login creates the
  account. A login is one operator at a time, so the flow runs once (no volume or concurrent users).
- **Seeded by SQL** in `otpstate-session-expired` (`lib/seed.py`, before any service starts): 6 workspaces as sign-up
  leaves them (owner with better-auth's own scrypt hash, credential, organization, owner member, team link), 48 accounts
  (`account_workspace`), 48 API keys, 19,200 ledger events, 14,400 `message_fact` rows, 18,000 `request_log` rows. The
  48 accounts' sessions are written into the upstream's state dir (`sessions/accounts/<id>/`, the layout a login
  writes) instead of 48 logins. After that, everything goes through real endpoints.
- **OF's `otpState` answer** (HTTP 400 `{"error":{"code":101,"message":"otpState","payload":{"otpState":{},
  "strong":false}}}`, the upstream's fixture `tests/fixtures/of_errors/otp_state.json`) is reconstructed from OF's web
  bundle, not captured. The fake gives it to every call of an account once the scenario flips it. The **step-up** answer
  (400 code 105, one path only) is a guessed shape, used to show a per-request refusal does not expire the account.
- **OF's socket** is driven by the scenario: it pushes `api2_chat_message` frames to a connected account (in order, one
  connection's frames on one thread) and closes an account's socket (1000) to make the upstream reconnect.
- **Knobs** (each recorded in the run's `metrics.json` `knobs`): `SLOP_WS_RECONNECT_MAX_S=2` sets the upstream's socket
  reconnect cap (`of_ws.RECONNECT_MAX_S`, 30 s in the product) so a reconnect loop shows within the window;
  `SENT_POLL_INTERVAL_S` / `MASS_POLL_INTERVAL_S=3600` make the pollers poll once at pump start, so only `/v1` calls
  reach an `otp-http` account's OF after the trigger; the API runs with `ALLOW_HTTP_WEBHOOKS=true` because the receiver
  is plain http on 127.0.0.1 (production refuses http and private addresses).
- **The Accounts page** has no refetch interval, so the scenario reloads it to see the settled status.

## Scenarios

- `browserbase-otp-login` — Try Browserbase login, OnlyFans asks for the 2FA code, the operator types it in the dialog.
  One operator, no volume.
- `otpstate-session-expired` — OF starts answering `otpState` for a quarter of 48 connected accounts while 42 API
  integrations call `/v1` and 36 accounts' sockets keep delivering: each affected account goes `session_expired` once
  (ledger, `/v1/accounts`, upstream, one signed webhook to its workspace), its socket stops reconnecting, `/v1/*` relays
  OF's 400, the owner sees "Session expired · re-connect", and nothing else changes.

Each scenario's docstring lists its checks, its faults and which checks a fault turns red.
