# WS5: reviewer pass (wave 2)

Launch (from the main checkout on `master`, after the final integration check in `README.md` passes):
`claude --agent reviewer --permission-mode plan "$(cat docs/runbook/ws5-review.md)"`

## Goal

Do a strict, read-only review of everything that landed for plan v2 against `docs/spec/plan-v2.md`. Your answer is
APPROVE or REQUEST CHANGES, with findings that a fix agent can apply without asking questions.

## Scope

- **Diff.** Run `git log --oneline v2-base..master` and `git diff v2-base..master`. Read the changed files in full
  where the diff lacks context.
- **Files owned.** None. You are read-only. Use Bash only for `git status`, `git diff` and `git log`.
- **Must not touch.** Everything: no edits and no commits. If you are blocked (a denied tool, an unreadable file),
  record it as an open question and continue.

## Read first

`docs/spec/plan-v2.md` (binding), `docs/runbook/ws1…ws4-*.md` (each workstream's contract), `docs/spec/review-mvp.md`
("Checked and OK" must still hold), and `.claude/agents/reviewer.md` (your approval bar).

## Check, citing file:line

1. **Spec conformance.**
   - The `Upstream` interface matches plan-v2 §4 exactly.
   - The compose services, ports, volumes, healthchecks, profiles and env match §3 and §5.
   - The start command runs migrations first.
   - The runtime image layout matches what `web-static.ts` resolves.
2. **Security (§6).**
   - `UPSTREAM_TOKEN` reaches only the adapter's outbound headers. It is never logged, never in an AppError
     message, never in a response header, and never in `request_log`.
   - The client's `authorization`, `cookie` and `host` are still never forwarded.
   - Only Caddy publishes ports, `TRUST_PROXY=1` matches the one hop in front, and the container user is not root.
   - `.dockerignore` keeps `.env*` out of the build context.
   - `deploy/.env` is gitignored.
3. **Tests.**
   - The api test count is at least the baseline of 66.
   - The removed JWT assertions were replaced by bearer assertions, not dropped.
   - The fake upstream enforces the bearer.
   - The tenant test still proves keys/logs isolation and the 409 `team_not_linked` gate.
4. **YAGNI and leftovers.**
   - No unrequested config knobs, abstractions, dependencies or files.
   - No `BACKEND_*`, `fast-jwt`, `backendUserId`, `x-backend-spec` or `backend_error` outside `docs/spec/**`.
   - No dead code from `lib/backend.ts`.
   - No description of the upstream beyond its three calls.
   - Account connection and session flows are only marked as "owned by the upstream service, not this repo".
5. **Docs.**
   - Every command in `deploy/hostinger.md`, `README.md` and `docs/getting-started.md` matches the code (paths,
     script names, env names, `node dist/db/link-team.js`).
   - Claims are not stronger than what the tests or the smoke script show.
6. **CI.** The `docker` job runs `scripts/compose-smoke.sh`, the `check` job is unchanged apart from the branch name,
   and the smoke script cleans up on failure.

## Output

Lead with the verdict: `APPROVE` or `REQUEST CHANGES`. Then list each finding as
`[blocker|major|minor] path:line — problem — concrete fix`, ordered by severity, then open questions. Keep it under
60 lines. The launcher passes your findings verbatim to a fix agent, so make each one self-contained.

## Commits

None: this is a read-only pass. The fix agent commits with
`git -c user.name=jakabasej -c user.email=jakabasej3@gmail.com commit -m "fix(<scope>): <summary>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.
