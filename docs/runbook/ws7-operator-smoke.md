# WS7: operator browser smoke (wave 2)

Launch (from the main checkout on `master`, after WS5/WS6 fixes are merged and the "Before launch" steps below are done):
`claude --chrome --agent operator "$(cat docs/runbook/ws7-operator-smoke.md)"`

## Before launch (the human does this; the operator has no shell and never types credentials)

```sh
cd /Users/jakabasej/gateway && pnpm install --frozen-lockfile
# terminal A: the fake upstream on 0.0.0.0:3001
UPSTREAM_TOKEN=smoke-only-upstream-token pnpm --filter @gateway/api exec tsx test/fake-upstream.ts
# terminal B: the production stack, plain HTTP on localhost
printf 'COMPOSE_PROFILES=caddy\nPUBLIC_URL=http://localhost\nPOSTGRES_PASSWORD=%s\nBETTER_AUTH_SECRET=%s\nUPSTREAM_URL=http://host.docker.internal:3001\nUPSTREAM_TOKEN=smoke-only-upstream-token\n' \
  "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > /tmp/gw-ops.env
alias dco='docker compose -p gateway-ops --env-file /tmp/gw-ops.env -f deploy/docker-compose.yml'
dco up -d --build --wait
```

`host.docker.internal` resolves by default on Docker Desktop (macOS). On Linux, add an override file with
`extra_hosts: ["host.docker.internal:host-gateway"]` on `gateway`. Then, in Chrome:
1. Open http://localhost and sign up with a throwaway email and password.
2. Read the workspace slug on Settings and run `dco exec gateway node dist/db/link-team.js <slug>`.
3. Leave that Chrome window signed in.

Teardown afterwards: `dco down -v`, then stop terminal A.

## Goal (operator)

Walk the dashboard as an operator would on a fresh deploy, and confirm the core loop works end to end against the
fake upstream: session, accounts, create a key, a playground call, the call in logs, and usage. You only operate
the browser. You never edit code, never run commands and never type credentials.

## Scope

- **Files owned.** None.
- **Must not touch.** No code or config changes. Stay on `http://localhost` and do not navigate to other sites.
- **Read first.** `docs/spec/plan-v2.md` §1 (what "deployed" means), then `docs/getting-started.md` (the page names
  and the expected flow).

## Steps (open a new tab; read pages as text; screenshot only if text is not enough)

1. **Session.** Open http://localhost/. The dashboard loads signed in (Home shows KPI cards). If you see the login
   page instead, stop and report "not signed in". Do not enter credentials.
2. **Accounts.** The Accounts page lists account `1`, "Demo" (`demo`, active). It does not show a `team_not_linked` hint.
3. **Create a key.** On the Keys page, create a key named `smoke-read` with read scope and no account restriction.
   The secret is shown once and starts with `gk_`. In your report, give only the visible prefix, never the full
   secret. After you close the dialog, the list shows `smoke-read` with read scope.
4. **Playground.** Pick the operation for `/v1/{account}/users/me` (search `users/me`), choose account `1` and
   send. Expect status `200`, a response body containing `"echo"` and `/of/users/me`, and a curl snippet.
5. **Logs.** The newest row is that call: `GET`, path ending `/users/me`, status `200`. Open its detail. It shows a
   request id. The page text contains no `authorization` or `cookie` value and no `smoke-only-upstream-token`.
6. **Usage and Home.** Usage shows at least 1 request for today, and the Home 24 h request count is at least 1.
7. **API reference.** http://localhost/docs renders and lists `/v1/{account}/users/me`. http://localhost/openapi.json
   loads.
8. **Revoke.** Revoke `smoke-read`. The list shows it as revoked.
9. **Sign out.** Sign out, and you land on the login page. Opening http://localhost/accounts while signed out also
   shows the login page. The human did the sign-in itself before launch.
10. **Console.** On each page above, read the browser console. Report any errors and the page they appeared on.

## Acceptance

All 10 steps pass. Exact commands do not apply because this pass is browser-only. Report in this format:

| # | Step | Pass/Fail | URL | Observed (short quote) |
|---|---|---|---|---|

Then list console errors, then each failure as expected vs observed. Keep it under 40 lines.

## Commits

None. This is a browser-only pass. Fixes go to an implementer, which commits with
`git -c user.name=jakabasej -c user.email=jakabasej3@gmail.com commit -m "fix(<scope>): <summary>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.
