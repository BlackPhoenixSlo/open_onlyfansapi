# WS8: open-source repo hygiene

Persona: implementer. Branch `ws8`, worktree `../gateway-ws8`.

## Goal

Add the files an open-source repo needs before its first public push, plus a pre-publish check script. Nothing else.

## Files you own

- `CONTRIBUTING.md` (new): how to run the stack locally (link to `docs/getting-started.md`, do not duplicate it), test commands, the commit convention, and that PRs must pass `pnpm -r typecheck && pnpm -r test` and `scripts/check-secrets.sh --all`.
- `SECURITY.md` (new): how to report a vulnerability privately (an email placeholder `contact@jackbase.dev` the user replaces), what is in scope (gateway, dashboard, compose), and a short threat summary: the gateway holds one upstream token; API keys are stored hashed; cookie writes need Origin + header.
- `scripts/prepublish-check.sh` (new, POSIX sh, executable): exits non-zero if any of these are true, printing each failure:
  1. `scripts/check-secrets.sh --all` fails.
  2. A tracked file outside `docs/spec/`, `.gitignore` and `scripts/check-secrets.sh` contains the third-party brand string or its key prefix (case-insensitive; the patterns live in the script).
  3. `README.md` lacks a line containing "not affiliated".
  4. `LICENSE` is missing or does not contain "GNU AFFERO GENERAL PUBLIC LICENSE".
  5. `docs/spec/pages.md`, `docs/spec/endpoints.md` or `docs/spec/mapping.md` are tracked (they must be moved out or deleted before publishing; print the `git rm --cached` hint, do not run it).
- `docs/runbook/ws8-repo-hygiene.md`: you may append a "Result" section at the end.

## Must not touch

Everything else. In particular `README.md`, `LICENSE`, `.gitignore`, `docs/**` other than this file, `apps/**`, `deploy/**`, `.github/**`, `scripts/check-secrets.sh`, `scripts/compose-smoke.sh`.

## Read first

`README.md`, `LICENSE`, `scripts/check-secrets.sh`, `docs/spec/plan.md` §11 ("Publishing"), `docs/spec/review-mvp.md` (the open items about the brand name).

## Acceptance

```sh
sh scripts/prepublish-check.sh; echo "exit=$?"      # must be non-zero now, because docs/spec/*.md are tracked, and list exactly that
git ls-files | grep -E '^(CONTRIBUTING|SECURITY)\.md$' | wc -l   # 2 after commit
```

The script must run in under 5 s and use only `git`, `grep`, `sh` built-ins.

## Commit

```sh
git add CONTRIBUTING.md SECURITY.md scripts/prepublish-check.sh docs/runbook/ws8-repo-hygiene.md
git -c user.name=jakabasej -c user.email=jakabasej3@gmail.com commit -m "chore: contributing, security policy and pre-publish check" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Report: the script's output on the current tree, and the commit hash.

## Result

Added `CONTRIBUTING.md`, `SECURITY.md` and `scripts/prepublish-check.sh` (executable, POSIX sh, ~0.1 s;
uses `git grep`, `git ls-files`, `grep` and `sh` only). The script builds the brand pattern by string
concatenation so it is not itself a match for check 2.

Run on this tree it exits 1 with two failures:

1. **check 5** — `docs/spec/pages.md`, `endpoints.md` and `mapping.md` are still tracked, with the
   `git rm --cached` hint printed (not run).
2. **check 2** — the brand also appears in `docs/runbook/*.md` (worktree paths in the launch commands and
   the quoted check-2 wording in this file). The acceptance note expected only (1); check 2 was implemented
   as written (exclusions limited to `docs/spec/`, `.gitignore`, `scripts/check-secrets.sh`), and these hits
   are real: the runbook is tracked and would be public. Decide at publish time whether to scrub the
   runbook paths, untrack `docs/runbook/`, or extend the exclusion list — WS8 does not own those files.

Nothing outside the four owned files was touched.
