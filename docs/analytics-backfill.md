# Analytics backfill (step 0)

Step 0 of the [client stats ask](spec/future-client-story-ask.md#6-first-slice-account-and-shift-performance): read one
account's past week from OnlyFans through the upstream, store it, write it to CSV, and diff it against the client's
Infloww export. The backfill runs from the command line only; the stats routes over what it stores (reply time,
openers, scripts) are in [analytics.md](analytics.md). Every row belongs to one workspace, and a workspace's key never
sees another workspace's rows.

Three commands, all run from the repo root:

| Command | What it does |
|---|---|
| `pnpm --filter @gateway/api analytics:claim --team <teamId> --account <id>` | Records that the account belongs to the workspace |
| `pnpm --filter @gateway/api analytics:backfill --account <id> --from <date> --to <date> --out <dir> [--team <teamId>] [--automation <file>]` | Backfills the range, then writes four CSVs to `<dir>` |
| `pnpm --filter @gateway/api analytics:diff --ours <dir> --infloww <file.csv> [--tz <offset>]` | Compares the CSVs with an Infloww export |

In the container, run `node dist/cli/analytics-<name>.js` with the same arguments (`docker compose exec gateway …`),
then copy the output folder out with `docker compose cp`. `deploy/docker-compose.yml` does not pass the
`ANALYTICS_*` variables below to the container, so set any you change on the command itself:

```sh
docker compose exec -e ANALYTICS_REQUESTS_PER_HOUR=300 gateway node dist/cli/analytics-backfill.js --account 1001 --from 2026-09-01 --to 2026-09-08 --out /tmp/1001-week36
```

## Before the first run

1. **Migrate.** `pnpm db:migrate` applies `0008_analytics` (tables `account_workspace`, `message_fact`,
   `chat_coverage`, `purchase_fact`), and `0009` to `0011` for the stats routes
   ([analytics.md](analytics.md#deploy)).
2. **Upgrade the upstream.** The backfill reads the welcome message from `GET /of/settings/welcome-message`, which is
   new in this release. An older upstream answers 404 and the run fails before it reads any chat.
3. **Link the workspace** if it is not linked yet: `pnpm --filter @gateway/api link-team <workspace-slug>`. It prints
   the workspace id (`linked workspace <slug> (<teamId>)`), which the other commands take.
4. **Allow the account on a key.** The workspace needs a live API key whose account allowlist names the account
   (Dashboard → API keys). An account named by another workspace's keys is refused with `account_workspace_conflict`.
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

The run reads, in order: mass-message history in one-day windows from the day before `--from` up to now (the chat
walks store messages on both sides of the range, and each outbound message's queue id is looked up there), the
welcome message, the chat list (most recent first, with `skip_users=none` so each chat carries the fan's username;
see below), each chat's messages newest first down to the page that reaches
`--from`, then the range's transactions. Messages on that boundary page older than the mass window (before the day
before `--from`) are stored once and never updated by a later run, since their mass history was not read. Mass history answers
one page of 100 per window; a full page may have been cut, so that window is split in halves until a page is not
full, and a full page for an hour or less fails the run.

OF answers about 10 chats a page (sometimes 17 to 19) whatever the `limit`, so the list is paged by each page's
`nextOffset` (by the number of chats returned when it is missing) until `hasMore` is false or a page adds no new
chat. The list is not strictly newest first: pinned and unread chats come first and older chats appear mid-list. So
one page with no chat active since `--from` does not end it; two such pages in a row do (`QUIET_CHAT_PAGES`). An
active chat listed after two quiet pages in a row is missed.

It prints the request count and whether it was stopped, then two checks:

- **unmatched queue ids**: outbound messages from the day before `--from` on carry a queue id that mass history
  does not list, so they are not counted as mass. A non-zero count means mass history and messages disagree.
- **incomplete chats**: chats whose walk stopped on a page with no new message id before reaching back to `--from`
  (OF ignored the cursor), so `chats.csv` shows an `oldest_at` after `--from` and `reached_start` false. Their
  messages before that time are missing.

Then the row count of each file. Last, stopped or not, it records the account's script candidates
([analytics.md](analytics.md#scripts)). Rows upsert, so a re-run never double counts, but it does request everything
again: there is no resume. A chat's coverage never moves back: a narrower re-run keeps the older oldest message and
`reached_start` an earlier run reached.

## Request budget

For one account-week: chat-list pages + for each chat active that week (its pages in the week + 1 boundary page) +
one mass-history window per day from the day before `--from` to today (8 for last week, more for an older week) +
transaction pages. With 1,000 active chats at about 2 pages each, that is roughly 2,000 requests, about 3.5 hours at
the default cap. The limits:

| Variable | Default | Meaning |
|---|---|---|
| `ANALYTICS_REQUESTS_PER_HOUR` | `600` | Upstream requests per account in any rolling hour. A guess: OF documents no limit |
| `ANALYTICS_PAGE_DELAY_MS` | `300` | Gap from the end of one response to the next request (the reference fetcher's delay) |
| `ANALYTICS_BACKOFF_MAX_MS` | `300000` | Longest wait after a 429, `Retry-After` included |

A 429 waits for `Retry-After`, or 1 s doubling per retry, never longer than the cap. After 8 retries of one request
the next 429 (the 9th in a row) fails the run; what was stored stays. One account is read at a time. The hourly cap counts one run's
requests only (each run, in its own process, starts from zero), so two runs back to back can reach twice the cap
within an hour: leave an hour between them, or lower the cap.

## Stopping

Press Ctrl-C. The run stops at once: a request in flight finishes, but a page delay, hourly-cap or 429 wait is cut
short and no new request is made. It still writes the CSVs from what was stored (`stopped: yes`). A chat whose walk
was cut short gets no new coverage in `chats.csv`, and transactions are read last, so a stopped run usually has
none. Ctrl-C a second time quits at once without writing.

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

## Diffing against Infloww

Ask the client for the **Message Dashboard export, one creator, one past week**, the same week as the backfill, with
the report time zone set to UTC+0 ([infloww-definitions.md §6](spec/infloww-definitions.md#6-exports)). Ask for
the Sales Records CSV for the same range too; the diff does not read it yet.

The export is an `.xlsx`. The repo has no spreadsheet reader, so open it in Excel, Numbers or Google Sheets, export
the sheet as CSV (UTF-8) and pass that:

```sh
pnpm --filter @gateway/api analytics:diff --ours ~/of-analytics/1001-week36 --infloww ~/Downloads/message-dashboard.csv
```

If the report was not in UTC, pass its offset: `--tz +02:00`. The diff touches neither the database nor the
upstream, and it exits 0 even with unresolved rows: it is a report.

What it prints:

- **The column mapping.** The Message Dashboard's own headers (`Sent date`, `Sent time`, `Replay time` (sic),
  `Price`, `Sender`, `Sent to`, `Status`, …) map first, then a few aliases matched case-insensitively. It lists the
  fields it could not map and the columns it did not use.
- **One line per difference**, ending in `explained: <rule>` or `unresolved`. The export has no message id and our
  CSVs have no text, so an Infloww row joins one of our outbound messages sent within ±60 s at the same price,
  preferring one in a chat whose `fan_username` (chats.csv) is the row's `Sent to` (case and a leading `@`
  ignored), then one whose reply time agrees, then a DM, then the nearest. A chat with no known username can still
  pick the wrong chat in a busy hour; the summary counts joins that had more than one candidate.
- **A summary**: matched, ours-only, infloww-only, explained (per rule), unresolved.
- **Reply time.** Infloww reports a mean per fan turn over replied turns, unreplied ones excluded. Its clock starts
  at the first unanswered fan message, moved later if the chat was marked read
  ([definitions §8](spec/infloww-definitions.md#8-local-evidence-added-2026-10-05)); its cap is unknown. The table
  puts our mean per replied turn (`in_cap` and `late`), with the timer from the turn's first and from its last fan
  message, beside Infloww's mean, and names the closer one. Our median and p90 over `in_cap` turns, and our mean per
  inbound message, have no Infloww counterpart and show `n/a`.

The rules live in one object, `RULES` in `apps/api/src/cli/infloww-diff.ts`; the first that holds explains a
difference:

| Rule | Explains |
|---|---|
| `mass`, `welcome`, `automated` | A message of ours that Infloww leaves out of DMs (definitions §7) |
| `scheduled` | A scheduled 1:1 send: it never closes a turn in Infloww, so Infloww has no reply row for it |
| `notAReply` | A DM of ours that ended no fan turn: the export has one row per reply |
| `withdrawn` | An Infloww row with a withdrawn status: unsent messages vanish from OF history |
| `outsideRange` | An Infloww row outside the time span of our `messages.csv` |
| `beforeCoverage` | An Infloww row older than our walk of that chat reached (only when the fan is a numeric id) |
| `lastFanMessage` | A reply time that matches ours timed from the turn's last fan message: Infloww starts the clock at the first unanswered fan message, moved later if the chat was marked read (definitions §8) |
| `afterScheduled` | An Infloww reply time on a DM that ended no turn for us, because a scheduled send closed it first (Infloww's scheduled sends do not close a turn) |
| `onlineOnly` | A reply of ours with no Infloww reply time: Infloww times only DMs to online fans (definitions §1) |

Anything else is unresolved. The usual case is a reply of ours that Infloww does not list, which may have been sent
from OF directly: Infloww sees only messages sent through it.
