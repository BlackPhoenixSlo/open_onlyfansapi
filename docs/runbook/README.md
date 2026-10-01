# Runbook: plan v2 (one-command VPS deploy)

Spec: [`docs/spec/plan-v2.md`](../spec/plan-v2.md). Each `wsN-*.md` file is a complete prompt for one agent.
Wave 1 runs in parallel, one git worktree per workstream, and no two workstreams own the same file. Wave 2 runs on
`master` after every wave 1 branch is merged.

## Waves

| Wave | WS | Prompt | Persona | Where | Launch |
|---|---|---|---|---|---|
| 1 | WS1 Docker image | `ws1-docker-image.md` | implementer | `../gateway-ws1` | `claude --agent implementer --permission-mode acceptEdits "$(cat docs/runbook/ws1-docker-image.md)"` |
| 1 | WS2 deploy stack | `ws2-deploy-compose.md` | implementer | `../gateway-ws2` | `claude --agent implementer --permission-mode acceptEdits "$(cat docs/runbook/ws2-deploy-compose.md)"` |
| 1 | WS3 upstream adapter | `ws3-upstream-adapter.md` | implementer | `../gateway-ws3` | `claude --agent implementer --permission-mode acceptEdits "$(cat docs/runbook/ws3-upstream-adapter.md)"` |
| 1 | WS4 CI | `ws4-ci-smoke.md` | implementer | `../gateway-ws4` | `claude --agent implementer --permission-mode acceptEdits "$(cat docs/runbook/ws4-ci-smoke.md)"` |
| 2 | WS5 review | `ws5-review.md` | reviewer | main checkout, `master` | `claude --agent reviewer --permission-mode plan "$(cat docs/runbook/ws5-review.md)"` |
| 2 | WS6 devil's advocate | `ws6-devils-advocate.md` | devils-advocate | main checkout, `master` | `claude --agent devils-advocate --permission-mode plan "$(cat docs/runbook/ws6-devils-advocate.md)"` |
| 2 | WS7 operator browser smoke | `ws7-operator-smoke.md` | operator | main checkout, `master` | `claude --chrome --agent operator "$(cat docs/runbook/ws7-operator-smoke.md)"` (do its "Before launch" steps first) |

WS5 and WS6 can run at the same time. Run WS7 after any fixes from WS5/WS6 are merged.

## 0. Once, in the main checkout

```sh
cd /Users/jakabasej/gateway
git add docs/spec/plan-v2.md docs/runbook
git -c user.name=jakabasej -c user.email=jakabasej3@gmail.com commit -m "docs: plan v2 and runbook" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git tag v2-base                       # WS5/WS6 review v2-base..master
docker compose up -d                  # dev Postgres on :5434, shared by every worktree (start it only here)
```

Worktrees branch from this commit, so each one already contains the runbook.

## 1. Worktree setup (wave 1)

Repeat for N = 1, 2, 3, 4:

```sh
cd /Users/jakabasej/gateway
git worktree add ../gateway-wsN -b wsN
cd ../gateway-wsN
pnpm install --frozen-lockfile
claude          # once, interactively: accept the trust dialog for this folder, then /exit
```

Then launch the line from the table **from inside that worktree**. Notes:
- **Separate test databases.** Each worktree runs the api tests against its own database
  (`TEST_DATABASE_URL=postgres://gateway:gateway@localhost:5434/gateway_test_wsN`). Parallel runs then can't
  truncate each other's tables. `test/global-setup.ts` creates the database if it is missing.
- **Permission prompts.** `.claude/settings.json` does not allow-list every command the prompts use (`docker run`,
  `docker exec`, `sh`, `git -c … commit`). Approve these when asked. Do not widen the settings for this.
- **One port 80 user at a time.** WS4's smoke script and WS7 both bind host port 80. Don't run them simultaneously.

## 2. Merge order: WS3 → WS1 → WS2 → WS4

WS3 goes first because it renames the env (`BACKEND_*` → `UPSTREAM_*`), and WS1, WS2 and WS4 boot the gateway with
the new names. For each branch, in order:

```sh
cd ../gateway-wsN && git merge master       # skip for WS3 (merged first)
# re-run that workstream's "Acceptance" section in the worktree; fix and commit until it passes
cd /Users/jakabasej/gateway && git merge --no-ff wsN
```

Conflicts should not happen because ownership is disjoint. If one does happen, a file was edited outside its
owner's list: keep the owner's version and send the other change back to its workstream. After WS3 merges,
rename `BACKEND_URL`/`BACKEND_TIMEOUT_MS` to `UPSTREAM_URL`/`UPSTREAM_TIMEOUT_MS` in your local `.env`, replace
`BACKEND_JWT_SECRET` with `UPSTREAM_TOKEN`, and point `UPSTREAM_URL` at your upstream (or at the fake, see
plan-v2 §5).

## 3. Final integration check (main checkout, `master`, after WS4 merges)

```sh
cd /Users/jakabasej/gateway
pnpm install --frozen-lockfile
pnpm db:generate && test -z "$(git status --porcelain apps/api/drizzle)"      # no migration drift
pnpm -r typecheck
TEST_DATABASE_URL=postgres://gateway:gateway@localhost:5434/gateway_test pnpm -r test   # api count >= 66, all green
sh scripts/check-secrets.sh --all
! grep -rnE "BACKEND_|fast-jwt|createBackend|x-backend-spec|backend_error" \
    apps/api/src apps/api/test apps/web/src docs/*.md README.md .env.example deploy .github
docker build -f apps/api/Dockerfile -t gateway:v2 .
sh scripts/compose-smoke.sh                                                    # healthz through Caddy, ports checked
git worktree list                                                              # then: git worktree remove ../gateway-wsN
```

All commands must pass before wave 2 starts.

## 4. Wave 2 and the fix loop

1. Run WS5 and WS6 from the main checkout. Both are read-only (`--permission-mode plan`) and print findings.
2. Paste their findings, **verbatim**, into one fix agent on `master`:
   `claude --agent implementer --permission-mode acceptEdits "Fix these findings. Spec: docs/spec/plan-v2.md. <findings>"`.
   Re-run WS5. Stop at APPROVE or after 3 rounds, and record any findings still open in the merge commit message.
3. Run WS7 last and fix any failing step the same way.

## Commit convention (all workstreams)

```sh
git -c user.name=jakabasej -c user.email=jakabasej3@gmail.com commit -m "<type>(<scope>): <summary>" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `ci`, `build`, `chore`. Make one logical commit per step, and don't push.
