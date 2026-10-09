# Analytics backfill (step 0)

Step 0 of the [client stats ask](spec/future-client-story-ask.md#6-first-slice-account-and-shift-performance): read one
account's past week from OnlyFans through the upstream, store it, and write it to CSV. The
backfill runs from the dashboard or the command line; the stats routes over what it stores (reply
time, openers, scripts) are in [analytics.md](analytics.md). Every row belongs to one workspace, and a workspace's key
never sees another workspace's rows.

## From the dashboard

The usual path. On **Accounts**, each `active` account has a range (30, 90 or 180 days; default 30) and
**Run analytics (N days)**. It calls `POST /v1/stats/backfill` with `days` ([analytics.md](analytics.md#routes);
the API takes 1 to 366), which:

1. checks the account is in the workspace's account list (`GET /v1/accounts`; for a key, within its allowlist), so no
   key naming the account is needed;
2. claims the account for the workspace (once; `409 account_workspace_conflict` if another workspace owns it);
3. starts the backfill of the last `days` days, now minus `days` days up to when the run starts (later, if it is
   queued behind another account), inside the API process, and answers at once. A long range takes hours at the per-hour request cap.

The row then polls `GET /v1/stats/backfill` every 3 s and shows `Running… N chats, M messages`, then
`Done · view Stats` (Stats for that account; `Done · N chats failed` when chats were skipped on a 4xx) or the error. The run is the CLI's backfill without CSVs, with the same
pacing, hourly cap and 429 backoff ([Request budget](#request-budget)), and it ends by syncing script candidates.

Limits:

- **One run per account at a time** (`409 backfill_running`), and one account at a time per API process: a second
  account's run shows `Queued…` until the first ends. A CLI run counts too: every run holds the account's backfill
  lock in Postgres ([Running a backfill](#running-a-backfill)), so the button answers `409 backfill_running` while
  `analytics:backfill` reads the account.
- **The status is in memory.** Restarting the API ends a run in flight and forgets its status (the account shows the
  button again). The rows already stored stay; press the button again (rows upsert, it requests everything again).
- **No stop button.** A run ends on its own, on an error, or with the API process.
- **Daily refresh.** With `STATS_REFRESH_HOUR_UTC` set, the API also starts a run of each claimed account once a day
  over the days since its last run (at most 7), shown on this page like a button run
  ([analytics.md](analytics.md#keeping-it-fresh)).

## From the command line

The CLI stays for `--dry-run`, `--automation <file>`, a range that does not end now, and the CSVs. Two
commands, all run from the repo root (the Infloww diff, `analytics:diff`, is parked on branch
`infloww-diff-parked` until the client's export exists):

| Command | What it does |
|---|---|
| `pnpm --filter @gateway/api analytics:claim --team <teamId> --account <id>` | Records that the account belongs to the workspace |
| `pnpm --filter @gateway/api analytics:backfill --account <id> --from <date> --to <date> --out <dir> [--team <teamId>] [--automation <file>] [--dry-run]` | Backfills the range, then writes four CSVs to `<dir>` |

In the container, run `node dist/cli/analytics-<name>.js` with the same arguments (`docker compose exec gateway …`),
then copy the output folder out with `docker compose cp`. `deploy/docker-compose.yml` does not pass the
`ANALYTICS_*` variables below to the container, so set any you change on the command itself:

```sh
docker compose exec -e ANALYTICS_REQUESTS_PER_HOUR=300 gateway node dist/cli/analytics-backfill.js --account 1001 --from 2026-09-01 --to 2026-09-08 --out /tmp/1001-week36
```

## Before the first run

1. **Migrate.** `pnpm db:migrate` applies `0008_analytics` (tables `account_workspace`, `message_fact`,
   `chat_coverage`, `purchase_fact`), `0009` to `0011` for the stats routes
   ([analytics.md](analytics.md#deploy)), `0012` (`message_fact.deleted_at`), `0013` and `0014`
   (`message_fact.tip_cents` and `is_opened`; `0013` fills them with one `UPDATE` of every stored message), and
   `0015` (`account_workspace.refreshed_at`).
2. **Upgrade the upstream.** The backfill reads the welcome message from `GET /of/settings/welcome-message`, which is
   new in this release. An older upstream answers 404 and the run fails before it reads any chat.
3. **Link the workspace** if it is not linked yet: `pnpm --filter @gateway/api link-team <workspace-slug>`. It prints
   the workspace id (`linked workspace <slug> (<teamId>)`), which the other commands take.
4. **Allow the account on a key** (CLI only: the dashboard button needs neither this nor step 5). The workspace needs a
   live API key whose account allowlist names the account (Dashboard → API keys); `analytics:backfill` checks it on
   every run that stores rows. An account named by another workspace's keys is refused with `account_workspace_conflict`.
5. **Claim the account:** `analytics:claim --team <teamId> --account <id>`. It is idempotent. Once claimed,
   `analytics:backfill` finds the workspace itself, so `--team` is optional.

`UPSTREAM_URL` and `UPSTREAM_TOKEN` come from `.env`, as for the server.

## Running a backfill

```sh
pnpm --filter @gateway/api analytics:backfill --account 1001 --from 2026-09-01 --to 2026-09-08 --out ~/of-analytics/1001-week36
```

`--from` is inclusive and `--to` exclusive, so the line above is one week. A date without a time is midnight UTC. A
relative `--out` is taken from the directory you typed the command in. Keep the folder out of the repo: it holds fan
ids.

The run reads, in order: the range's transactions (first, so a run that dies during the hours of chat walks still
stores the money), mass-message history in one-day windows from the day before `--from` up to the run's start (the
chat walks store messages on both sides of the range, and each outbound message's queue id is looked up there; it is
read once, before the walks, so a broadcast sent during the run is stored as DMs until the next run over its day), the
welcome message, the whole chat list (with `skip_users=none` so each chat carries the fan's username; see below), then
each chat active in the range and each chat the list left out (below), its messages newest first down to the page that
reaches `--from` or to the chat's start (OF's last page of a chat's messages still says `hasMore`; the empty page
after it says false, and the walk records `reached_start`). Messages on that boundary page older than the mass window
(before the day before `--from`) were derived without their mass history, so a later run that reads them again updates
every column but `is_mass`, `is_automated` and `automated_reason`, and clears `deleted_at`; only a run whose `--from`
covers them re-derives those flags. With each page it stores (in the page's transaction), the run marks mass every stored outbound message of
the account whose queue id (one of the page's) is on outbound messages in 8 or more chats: a bulk send, which the mass
history may not list ([Terms](analytics.md#terms)); rows stored before are marked by the next run over their range, and
no run clears the mark. A dry run marks its own rows the same way. Mass history answers one page of 100 per window; a full page may have been cut, so
that window is split in halves until a page is not full, and a full page for an hour or less fails the run.

OF answers 10 to 20 chats a page whatever the `limit`, so the list is paged by each page's `nextOffset` (by the
number of chats returned when it is missing) until a page is empty, `hasMore` is false, or three pages in a row add no
new chat (one such page is the list moving while it is read). The list is read to its end (about 80 to 160 pages for
1,600 chats): it is not newest first (unread chats come first, a mass message does not move a chat, and the last part
is ordered by fan id), so a page with no chat active since `--from` does not end it. OF lists a chat whose latest
message was deleted with `lastMessage: null`; such a chat counts as active and is walked, so its other messages are
read. A chat listed without a readable last-message time is not walked.

OF's offset also counts chats the list does not return: a page of 20 places held 13 to 19 chats on 2026-10-09, and
a chat with messages in the range (a fan with `isActive: false`) was never listed. So after the listed chats the run
walks the range's payers (the fans of its transactions, and of the transactions already stored from 12 hours
before `--from`: OF lists a sale hours late, so the hourly poll may store one after the run that covered its time)
that the list did not name or names as not active in the
range (a fan who bought an older PPV in the range has no newer message; the walk reads the PPV again, with its
`isOpened`, when it is on the pages down to `--from`), with the list's names when it named them, and the chats with
stored messages (from earlier runs and live events) that the list did not name (fan ids that are positive safe
integers, not the account's own); a dry run seeds from the transactions only. A chat whose first messages page OF answers 404 (a deleted fan's) is skipped and
counted as not found. A chat the list leaves out that neither paid in the range nor has a stored message is still
missed.

One chat's 4xx does not end the run: a chat the upstream answers any other 4xx (a 404 after its first page, or one
that is not OF's) is skipped, and its id is printed. Five chats in a row that OF itself refuses with a 400 or 403 do
end it: OF answers every chat read of a dead session 400 "Wrong user" or 403, so the run fails with "OF session of
account <id> expired (OF refused 5 chats in a row with a 400 or 403): re-connect it in Accounts, then run the
backfill again" (`errorCode: session_expired`, as for a 401). A walked chat resets the count; a chat OF answers 404
for (not found) and a chat skipped on another 4xx (one not OF's own 400 or 403) neither count nor reset it. A 401
still ends the run (the session expired), a 429 ends it past its retries, and a 5xx ends it (a 502, 503 or 504 past
its retries).

Every 5 minutes it prints a progress line to stderr, such as `progress: chats, 4210 requests, chats 830/1612, ETA 2h 5m`:
the phase (`transactions`, `mass history`, `welcome message`, `chat list`, then `chats`), the requests made, the chats
walked or skipped of those to walk (known once the chat list is read), and the time left at the pace of the chat walks
so far. If the run fails (a dead session, the upstream down or rate limiting past the retries, a database error), it
prints the error, the last progress line and the counts below, and still writes the CSVs from what was stored (a dry
run: from what it read), then exits 1. A CSV that cannot be written (the database is down) is an error of its own.

It prints the request count and whether it was stopped (`failed` after an error), then:

- **incomplete chats**: chats whose walk stopped on a page with no new message id before reaching back to `--from`
  (OF ignored the cursor), so `chats.csv` shows an `oldest_at` after `--from` and `reached_start` false. Their
  messages before that time are missing. A walk that ends on OF's empty last page (`hasMore` false) reached the chat's
  start and is not counted.
- **chats the list left out**: walked from the payers and stored messages, with how many OF answered 404 for (skipped);
  the list entries dropped for no readable fan id; and the chats failed on another 4xx (skipped), with the first 20
  ids.

Then the row count of each file. Last, stopped or not, it records the account's script candidates
([analytics.md](analytics.md#scripts)), and a stored run that ran to its end and whose `--to` is not before
its start moves `account_workspace.refreshed_at` forward to its start ([analytics.md](analytics.md#keeping-it-fresh));
a run of an older range does not move it. The daily refresh and the status time read it. Rows upsert, so a re-run never double counts, but it does request everything
again: there is no resume. A chat's coverage never moves back: a narrower re-run keeps the older oldest message and
`reached_start` an earlier run reached.

**One run per account across processes.** A run (CLI, dry run included, or the API's) holds a Postgres advisory lock
on the account id, `pg_try_advisory_lock(<account id>)`, on a connection of its own from its start to its end, and
releases it with `pg_advisory_unlock` on that connection. A lost connection drops the lock, so the run fails at its
next request with "backfill lock lost (Postgres connection dropped): run again" (the rows stored stay;
`refreshed_at` does not move). A second run of the same
account on the same database, from any process, fails at once with "A backfill of account <id> is already running
(…): wait for it to end, then run again" (`409 backfill_running` from the dashboard), and the CLI exits 1. Runs of
different accounts in different processes still run side by side. To see who holds it: `SELECT pid, objid FROM
pg_locks WHERE locktype = 'advisory'`.

`--dry-run` makes the same requests (less the walks of chats seeded from stored messages) but stores nothing (no
claim, rows, coverage or script candidates) and writes the CSVs from what it read, for comparing a fresh re-read with
the stored rows. Its `chats.csv` lists this run's walks only, and its `reply_times.csv` sees only the messages walked
(back to each chat's boundary page). Its incomplete-chats count comes from this run's walks only (no stored coverage
is merged). `--team` is unchecked in a dry run: nothing checks that the workspace is linked or allowed the account.

## Request budget

For one account-week: chat-list pages + for each chat active that week (its pages in the week + 1 boundary page) +
one mass-history window per day from the day before `--from` to today (8 for last week, more for an older week) +
transaction pages. With 1,000 active chats at about 2 pages each, that is roughly 2,000 requests, about 3.5 hours at
the default cap. Add 1 messages page per chat listed with `lastMessage: null`, the list pages past the last active
chat, and the pages of each chat the list left out. The limits:

| Variable | Default | Meaning |
|---|---|---|
| `ANALYTICS_REQUESTS_PER_HOUR` | `600` | Upstream requests per account per hour, spread evenly: a request starts every 3,600,000 / N ms (6 s at 600), never a burst of N and then an idle wait for the hour to pass. A guess: OF documents no limit |
| `ANALYTICS_PAGE_DELAY_MS` | `300` | Gap from the end of one response to the next request (the reference fetcher's delay) |
| `ANALYTICS_BACKOFF_MAX_MS` | `300000` | Longest wait after a 429, `Retry-After` included |

A 429 waits for `Retry-After`, or 1 s doubling per retry, never longer than the cap. After 8 retries of one request
the next 429 (the 9th in a row) fails the run; what was stored stays. Its message names the retries and the cap
(`ANALYTICS_REQUESTS_PER_HOUR`) and says to wait, then run again with a lower cap. A 502, 503, 504 or network error (a
transient proxy failure) is retried up to 8 times after 1 s, 3 s, 9 s, 30 s, 1 min, 2 min, 5 min and 10 min (about
19 min in all, so a restart of the upstream container does not end a long run), each attempt spaced like any
request; the 9th failure in a row fails the run, with a message to check that the upstream at `UPSTREAM_URL` is
running and answers within `UPSTREAM_TIMEOUT_MS` and to read its logs. Other 4xx fail it at once (an OF 400 or 403
outside a chat walk adds: if the account's OF session is dead, re-connect it in Accounts), and the dashboard shows
the run's retries ("Done · 2 retries"). A 401 means OF refused the account's session: the run fails at once with "OF
session of account <id> expired: re-connect it in Accounts, then run the backfill again" (`errorCode:
session_expired`), and the account shows "Session expired · re-connect". One account is read at a time per process, and one run per account across processes (the lock above). The spacing
paces one run's requests only (each run, in its own process, paces itself), so runs of two accounts at once (a CLI
run and a dashboard run) make twice the requests through the upstream: run one at a time, or lower the cap.

## Stopping

Press Ctrl-C. The run stops at once: a request in flight finishes, but a page delay, spacing or 429 wait is cut
short and no new request is made. It still writes the CSVs from what was stored (`stopped: yes`). A chat whose walk
was cut short gets no new coverage in `chats.csv`. Transactions are read first, so a stopped run has them unless it
stopped within its first few requests. Ctrl-C a second time quits at once without writing.

## The CSVs

Times are ISO 8601 in UTC, booleans `true`/`false`, and an empty field is null. Only rows of the claimed workspace
and of the range are written. No message text is exported: outbound text appears as a hash only, and fan text stays
in the database.

| File | One row per | Columns |
|---|---|---|
| `messages.csv` | message in the range | `message_id`, `chat_id` (the fan's user id), `created_at`, `direction` (`inbound`/`outbound`), `is_mass`, `queue_id`, `is_automated`, `automated_reason` (`welcome`/`automation`), `price_cents`, `is_tip`, `media_count`, `text_hash` (the script hash, [analytics.md](analytics.md#scripts); outbound only, empty when the text is too short to be a script) |
| `chats.csv` | chat the walks covered | `chat_id`, `fan_username` (from the chat list, else a message; empty if neither names it), `oldest_message_id`, `oldest_at`, `reached_start` (a walk hit the chat's first message), `walked_at`, then counts in the range: `messages_total`, `inbound`, `outbound`, `dm` (outbound, not mass, not automated), `mass`, `automated` |
| `transactions.csv` | OF transaction in the range | `tx_id`, `created_at`, `kind`, `gross_cents`, `net_cents`, `currency`, `fan_id`, `fan_id_source` (`field` or `description`) |
| `reply_times.csv` | fan turn starting in the range | `chat_id`, `inbound_at` (the turn's first fan message), `dm_at` (the reply; empty while open), `wait_seconds`, `status` (`in_cap`: replied within the 12 h cap; `late`: replied after it; `breached`: no reply and the cap has elapsed; `pending`: no reply yet, cap not elapsed), `breached` (`true` only when `status` is `breached`), `is_automated` (a welcome or automation went out during the turn) |

Mass, automated, DM and fan turn are defined in [section 2 of the spec](spec/future-client-story-ask.md#2-what-we-can-measure).
`automated_reason` is `welcome`, or `automation` for an outbound message whose text matches one of the client's
automation texts. Pass those with `--automation <file>`: a text file, one automation text per line, blank lines
ignored; matching uses the script normaliser's text steps (tags, case and spacing do not matter; fan names are not
replaced). Without it,
`automated_reason` is `welcome` or empty.
