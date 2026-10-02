## What and why

<!-- One topic per PR. Link the issue if there is one. -->

## How I verified it

<!-- The commands you ran and their result. -->

- [ ] `pnpm -r typecheck && pnpm -r test`
- [ ] `sh scripts/check-secrets.sh --all`
- [ ] Schema change: generated migration (`pnpm db:generate`) is in the same commit
- [ ] Behaviour change: a test is added or updated
- [ ] No secrets, `.env` files or vendor brand names
