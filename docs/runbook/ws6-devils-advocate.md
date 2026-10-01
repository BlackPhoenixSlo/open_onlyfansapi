# WS6: devil's advocate pass (wave 2)

Launch (from the main checkout on `master`, after the final integration check in `README.md` passes; it can run at
the same time as WS5):
`claude --agent devils-advocate --permission-mode plan "$(cat docs/runbook/ws6-devils-advocate.md)"`

## Goal

Argue that plan v2 as merged will fail a stranger who follows `deploy/hostinger.md` on a fresh Hostinger VPS. Find
what breaks first, under what input, and the smallest fix. Assume it is wrong until the evidence says otherwise.

## Scope

- **Diff.** `git log --oneline v2-base..master` and `git diff v2-base..master`, plus `docs/spec/plan-v2.md`.
- **Files owned.** None. You are read-only. Use Bash only for `git status`, `git diff` and `git log`.
- **Must not touch.** Everything: no edits and no commits.

## Attack these, citing file:line

1. **First boot.**
   - Does the image build on a 2 GB VPS?
   - What happens when ACME runs before DNS has propagated, or when port 80 is closed?
   - Can migrations fail halfway on start, and does the container then restart-loop?
   - What happens when `POSTGRES_PASSWORD` contains URL-unsafe characters?
2. **Day 2.**
   - Does `git pull && docker compose up -d --build` lose data?
   - What does `docker compose down -v` destroy, and does the guide warn about it?
   - Does a backup restore into a newer schema?
   - Are certificates kept across rebuilds?
   - Do logs or `request_log` fill the disk?
3. **Security.**
   - Every path by which `UPSTREAM_TOKEN` could leave the gateway.
   - Open sign-up on a public URL.
   - Whether `TRUST_PROXY=1` is still true in tunnel mode, and if a port is ever published by mistake.
   - Whether anything bypasses Caddy.
   - Cookies over plain HTTP if `PUBLIC_URL` is `http://`.
4. **Overstated claims.** Docs or reports that promise more than the code, tests or smoke script show. Examples: "one
   command", "zero downtime", "secure by default".
5. **YAGNI.** Anything built that plan-v2 did not ask for. Also anything the plan asked for that turned out
   unnecessary, such as profiles, the adapter interface or the link gate.
6. **Hidden assumptions.**
   - Docker Compose version (`--wait`, `COMPOSE_PROFILES` read from the env file).
   - Architecture: an arm64 VPS or a Mac building amd64.
   - Node and pnpm pins, `host.docker.internal` on Linux.
   - The `master` branch name in CI.
7. **Plan open questions (§8).** For each one, say whether its default is safe for a first public release.

## Output

Give at most 12 findings, ranked by "breaks first". Write each as
`[break|risk|overclaim|yagni] path:line — scenario — smallest fix (or "accept: <reason>")`. End with the single
change you would make before anyone else deploys this. Keep it under 50 lines. Your findings go verbatim to a fix agent.

## Commits

None: this is a read-only pass. The fix agent commits with
`git -c user.name=jakabasej -c user.email=jakabasej3@gmail.com commit -m "fix(<scope>): <summary>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.
