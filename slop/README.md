# slop/ — the repo's one real-path harness

`slop/run all` brings up the real stack on loopback (web via Vite, the TS API, the upstream, a fresh `gateway_slop`
database), drives each user flow through its real endpoints and UI, and asserts invariants. Everything outside the repo
is faked at its wire boundary by `lib/`, never inside service code. Extend this harness; do not fork it.

```
slop/run --list                         # scenarios and the faults each supports
slop/run all                            # every scenario; exit 0 = all green
slop/run browserbase-otp --fault otp-code-never-consumed   # break it once: only the targeted checks go red
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
| `lib/recorder.py`, `lib/report.py` | recorded HTTP client; checks, metrics, verdict |
| `scenarios/<flow>.py` | one file per user flow: `async def run(ctx, out, fault)` and `FAULTS` |

## Declared fakes and bypasses

- **Browserbase** is a local HTTP fake in its `/v1` shapes; a session is a fresh local headless Chromium whose CDP URL is
  the `connectUrl`. Its live view is a page of CDP screenshots, not Browserbase's interactive devtools page.
- **OnlyFans' site** is served over HTTPS on loopback; the session Chromium maps `onlyfans.com` to it
  (`--host-resolver-rules`, everything else NOTFOUND) and accepts its self-signed certificate. Its 2FA page puts a
  hidden stale `input[name=code]` ahead of the real one; a wrong code re-renders the prompt with an error. Two more
  accounts get a reCAPTCHA frame on that prompt, served by the same fake site: one left over hidden (a
  visibility:hidden container off screen), one on screen next to the code field.
- **OnlyFans' API and socket** (used after the login by the capture pipeline and pollers) are loopback fakes; the upstream
  reaches them by IP via module constants set in the launcher, so its `.onlyfans.com` cookies are not sent there; the
  fake authenticates by the verified signature. The signing material is synthetic.
- **The guard** does not cover child processes of the upstream (Playwright's driver, Chromium); the session Chromium is
  confined by its resolver rules, and the driver only talks to it.
- **Nothing is seeded by SQL** in `browserbase-otp-login`: sign-up links the workspace and the login creates the
  account. A login is one operator at a time, so the flow runs once (no volume or concurrent users).

## Scenarios

- `browserbase-otp-login` — Try Browserbase login, OnlyFans asks for the 2FA code, the operator types it in the dialog;
  then a 2FA prompt with a leftover hidden captcha (the code field still shows and logs in) and one with a captcha on
  screen (a challenge for the live view, no code field). Checks and the faults are listed in the scenario's docstring.
