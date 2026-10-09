# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Webhook event `chat_queue.finished` is now sent: the upstream reads each account's mass-message history every `MASS_POLL_INTERVAL_S` seconds (default 120, 10 to 86400; `0` turns it off; one OF request per poll per account) and sends each broadcast once, the first time a poll lists it with `sentCount` above 0 (OF lists a broadcast once its last copy has gone out, with its final count; within one poll interval, 2 minutes at the default). The payload is OF's history entry (`id` = queue id, `date`, `text`, `sentCount`, `viewedCount`, `isCanceled`, ...), `ts` its `date`; later changes send nothing. A queued send to a single fan is sent too, though the analytics count it as a DM. Missed: broadcasts that reached nobody, ones that finished more than two poll intervals before the upstream started or the account's connection was last restarted (a re-connect, a proxy change, a crash), ones OF could not be read for in the 24 hours after them, and past 50 in 24 hours. `chat_queue.updated` stays TBC ([docs/webhooks.md](docs/webhooks.md)).
- Analytics refresh, off by default: new optional `STATS_REFRESH_HOUR_UTC` (0 to 23; unset or empty = off). Set, it turns on an hourly transactions poll: each claimed account's transactions of the last 48 hours, one request per account per hour, upserted into `purchase_fact` with the backfill's mapper, so Revenue follows sales without a new backfill; and a daily refresh: once past that hour UTC, each claimed account not refreshed since gets one backfill from max(now - 7 days, `refreshed_at` - 1 hour) to now, started like the dashboard's (never awaited; a dead session is skipped until the next day, in memory) ([docs/analytics.md](docs/analytics.md#keeping-it-fresh)). Migration `0015` adds `account_workspace.refreshed_at`, which every stored backfill that runs to its end (CLI, dashboard or refresh) moves forward to its start, or its `to` when earlier.
- Dashboard: a backfill line under the Stats, Revenue and Conversations range, "Backfill: refreshed 6h ago · next 03:00 UTC" ("next: off" when the daily refresh is off), beside the live line. `GET /v1/stats/config` `freshness` adds `lastRefreshAt` (the newest `refreshed_at` of the accounts in scope) and `nextRefreshAt` (null when off) ([docs/analytics.md](docs/analytics.md#live-updates)).
- Webhook event `messages.sent` is now sent: OF's socket never delivers an account's own messages, so the upstream polls each account every `SENT_POLL_INTERVAL_S` seconds (default 120, 10 to 86400; `0` turns it off) and emits the account's own DMs with `toUser` (`{ id, _view }`) within one poll interval unless the chats that changed in that interval hold more than 8 pages of about 10 messages (a busy chat can take 2 or 3); then the rest follow on later polls in order. Mass and other queued messages (`isFromQueue`) are not sent. Sends are missed while the upstream is down, in read chats while the account has more than about 50 unread chats, past about 30 messages in one chat between polls, and, when more than 200 changed chats wait for a later poll, in the chats that have waited longest (among chats that changed in the same interval, the most recently active ones). At most 13 OF requests per poll per account (about 390 an hour at 120 s) ([docs/webhooks.md](docs/webhooks.md)).
- Dashboard: a **Revenue** page (after Conversations) with the Stats range and account picker: Gross (booked sales: OF's status `done` plus `loading`, so refunds and reversals, `undo` and `pending_return`, are left out; settled and pending shown under it), Net, Transactions, Payers, Fan CVR (payers over fans messaged), Golden ratio (Infloww's: PPV DMs over DMs sent, mass and automated messages left out) and PPV unlock (DM; an upper bound, since a PPV unsent before anyone bought it vanishes from OF's history) cards, gross by day, a table by kind, and the top 50 payers (name, deleted account, gross, net, transactions, last purchase, and whether their chat is stored, linked to Conversations), with how many payers of the range have no stored chat and their gross (`topPayers[].isDeleted`, `withoutChat`). API: `GET /v1/stats/revenue` (`from`, `to`, `accountId`; scoped like the other stats routes) sums the backfilled booked transactions (`purchase_fact`; `totals.settledGross` is status `done`, `totals.pendingGross` status `loading`) and PPV DMs (`message_fact`; `totals.fanCvr`, `totals.goldenRatio` = `dmPpvs / dmMessages`, `ppv` the DM unlock rate; `fansMessaged` reads only accounts with a booked sale in the range) in cents, rates in percent, with `byDay` zero-filled in the config timezone ([docs/analytics.md](docs/analytics.md#revenue)). No migration.
- Dashboard: a **Conversations** page lists every fan with a stored message in the range and shows the selected fan's thread over the 366 days up to the range's end as chat bubbles (fan left, creator right; day separators and times in the workspace timezone; PPV price and bought/not bought, tip, media count, mass, automated (with the reason) and unsent badges; mass messages not bought as of the last read, by a backfill or the live event that stored them, hidden by default), with a CSV download for the thread; the Stats Fans card links each fan to it with the Stats range. API: `GET /v1/stats/messages` JSON takes `cursor` (the `nextCursor` of the previous page; a bad one is 400 `invalid_cursor`) and returns `nextCursor`, and each message carries `automatedReason`, also the CSV column `automated_reason` after `is_automated` ([docs/analytics.md](docs/analytics.md#stored-messages-and-export)). No migration.
- Stats: stored messages per fan and their export ([docs/analytics.md](docs/analytics.md#stored-messages-and-export)). `GET /v1/stats/fans` lists each fan with a message in the range (username; fan, DM, mass and automated message counts, which sum to the fan's messages; first, last and last fan message), the latest fan message first, with `total` before `limit`; `GET /v1/stats/messages` returns the messages themselves as plain text with direction, price, tip, media count, mass and automated flags, for one fan (`chatId`) or all, `direction=in` for the fans' messages only, as JSON (`limit` up to 5000, `truncated` when cut) or `format=csv` (the whole range, streamed, plain UTF-8). Scoped like the other stats routes. The Stats page has a Fans card with per-fan CSV links and Download fan replies / Download all messages for the page's account and range. The messages were already stored for backfilled ranges and live events, and are not purged by retention; no migration.
- Stats: the message export carries each message's PPV, media and tip detail: `isOpened` (a priced message the fan bought) and `tipCents` (OF's `tipAmount`) are stored columns derived like the others, and `isFree`, `photos`, `videos`, `gifs` (GIPHY included), `audios`, `hasPreview`, `isReply`, `isLiked` are read from OF's stored message object, with `deletedAt`, in JSON and as CSV columns ([docs/analytics.md](docs/analytics.md#stored-messages-and-export)). `GET /v1/stats/fans` adds `ppvSent`, `ppvOpened`, `tips` and `tipCents`; the Fans card shows PPV (bought/sent) and Tips. A `messages.deleted` event (an unsend) now keeps the message's row and marks it with `deleted_at` instead of removing it; a backfill that reads the message again clears the mark; deleted messages still count in the metrics, openers, scripts and fan counts. Migrations `0012` (nullable `message_fact.deleted_at`), `0013` (`message_fact.tip_cents` and `is_opened`; its one-time fill is a full-table `UPDATE` of `message_fact`, so it takes a while on a large table, and handles JSON numbers only, the next backfill re-deriving the rows it reads) and `0014` (drops their column defaults).
- Dashboard: **Run analytics (N days)** on each active account of the Accounts page, with a 30, 90 or 180 day range beside it (default 30; long ranges take hours at the per-hour request cap), claims the account for the workspace and runs the analytics backfill of the last N days in the background (no CSVs), showing chats and messages as it goes, then a link to Stats. API: `POST /v1/stats/backfill` `{ accountId, days? }` (session or `write` key; the account must be in the caller's `GET /v1/accounts`, else 404; another workspace's account is 409 `account_workspace_conflict`; a run in progress is 409 `backfill_running`) answers 202 `{ runId }`; `GET /v1/stats/backfill?accountId=` returns the run's status and counts, or `idle`. Run state is in memory: an API restart loses it and ends a run in flight. The CLIs stay for `--dry-run`, `--automation` and the CSVs ([docs/analytics-backfill.md](docs/analytics-backfill.md#from-the-dashboard)).
- Analytics live updates ([docs/analytics.md](docs/analytics.md#live-updates)): `messages.received` and `messages.sent` events for a claimed account add the message's `message_fact` row (the backfill's mapper; a stored row is kept; live outbound rows are DMs, mass messages and queued single DMs being stored only by a backfill, and no live row is automated until a backfill over its range re-derives it) and `messages.deleted` marks it deleted; scripts and chat coverage stay backfill-only. `GET /v1/stats/config` returns `freshness` (`lastLiveAt`, `liveEvents24h`) and the Stats page shows when the last message event arrived and how many came in the last 24 hours. No migration.
- Analytics step 1, reply time ([docs/analytics.md](docs/analytics.md)): `GET /v1/stats/metrics` lists each metric with its formula in words, the windows it reads and `verified: false` (not yet checked by hand in OF or against Infloww); `GET /v1/stats/metrics/:id` returns rows by `day`, `hour` or `account` in the workspace timezone, as JSON or `format=csv`; `GET /v1/stats/metrics/:id/samples` returns up to 20 turns behind a number with message ids and times. Metrics `reply_time` (median over fan turns replied within `reply_cap`), `reply_time_mean` and `reply_time_mean_last` (Infloww-comparable means over replied turns, from the turn's first or last fan message), `reply_sla` (replied within `sla` over turns not pending) and `reply_time_substantive` (only a DM of `min_reply_chars`+ ends a turn), each with in-cap, late, breached and pending counts. `GET` and `PUT /v1/stats/config` read and change the workspace's windows and timezone (an IANA name; an offset like `+02:00` is `400 validation_error`, since Node and Postgres read its sign oppositely; migration `0009`, table `stats_config`; `PUT` needs a `write` key and bumps `version`, which every result cites). The routes are scoped like `GET /v1/stats` and to the workspace's own rows: `409 team_not_linked` for an unlinked workspace, `403 account_not_allowed` for an `accountId` outside the key's allowlist.
- Analytics step 2, openers (compute only, unverified): metrics `openers`, `opener_reply_rate` and `opener_fan_reply_time`. An opener is a DM with no fan message and no DM in the chat for `open_gap` before it (mass and welcome messages do not reset the gap; after an unanswered fan message it is a late reply), of kind `first_ever`, `reactivation` or `unknown` from chat coverage, and `replied`, `no_reply` or `pending` against `open_reply`.
- Analytics step 3, script candidates (compute only, unverified, no money): the script normaliser v1 (strip tags, unescape HTML, NFKC, lowercase, collapse whitespace, fan's name, username and custom name to `<name>`; 4+ words or 20+ characters) hashes every outbound message into `message_fact.text_hash` with its `normaliser_version`; a hash sent 5+ times in 3+ chats within 30 days on one account is a script (migrations `0010` and `0011`: table `script`, `chat_coverage.fan_name` and `fan_custom_name`). `GET /v1/stats/scripts` lists scripts sent in a range with sends, chats, reply rate per outbound sequence within `open_reply` (and a substantive variant) and up to 5 exact variants. The backfill records the account's scripts when it ends. CLI `analytics:rehash` (rebuilds an account's hashes from stored text; run it once per account after migrating, since older rows have no normaliser version and are left out of scripts).
- Analytics follow-up to steps 1–3 (unverified): metric `reply_time_p90` (90th percentile of the `reply_time` waits, same in-cap turns and `n`, linear interpolation between closest ranks); metric `opener_reply_rate_substantive` (only a fan message of `min_reply_chars`+ is a reply); opener metric rows carry `massOrAutomatedGap`, the openers whose gap held mass or automated messages (CSV column `mass_or_automated_gap`); `GET /v1/stats/scripts` items carry `sendsAll` and `chatsAll`, the sends and distinct chats over all stored DM sends of the hash over the accounts in scope (the same population script detection reads), in range or not; a key limited to some accounts may see fewer (`sends` and `chats` stay in range). The `reply_time_substantive` catalogue description names the text normaliser.
- Analytics backfill: `--dry-run` makes the same requests but stores nothing (no claim, no message, coverage or purchase rows, no script sync) and builds the CSVs from the rows read, to compare a fresh re-read with what is stored.
- Analytics step 0 (backfill only, no routes; [docs/analytics-backfill.md](docs/analytics-backfill.md)): a new `analytics` module reads one account's range of messages, mass history (from the day before the range up to now, a full window split down to an hour), welcome message and transactions through the upstream, paced from the end of each response, capped per hour within a run, backing off on 429 and stopped at once with Ctrl-C (an `AbortSignal`), into four workspace-scoped tables (migration `0008`: `account_workspace`, `message_fact`, `chat_coverage`, `purchase_fact`), with derived mass, automated and fan-turn reply times (status `in_cap`, `late`, `breached` or `pending`). Chat coverage merges and never moves back; boundary messages older than the mass window update every column but their mass and automated flags, which only a run whose range covers them re-derives. The chat list is read down to two pages in a row with no chat active in the range, so a pinned or out-of-order older chat does not end it. CLIs: `analytics:claim` (an account belongs to one workspace) and `analytics:backfill` (takes the client's automation texts with `--automation <file>`, reports incomplete chats, and writes `messages.csv`, `chats.csv` with the fan username, `transactions.csv`, `reply_times.csv`; no message text). New optional `ANALYTICS_REQUESTS_PER_HOUR` (default 600), `ANALYTICS_PAGE_DELAY_MS` (300) and `ANALYTICS_BACKOFF_MAX_MS` (300000). The upstream serves `GET settings/welcome-message` (the `reply_on_subscribe` template, or null); the backfill needs it, so upgrade the upstream with the gateway.
- Dashboard: the webhook event picker is a compact grid grouped by prefix with a select-all per group, so the whole catalogue fits on one screen. `GET /v1/webhooks/events` items carry a typed `status` (`emitted` | `tbc` | `never`).
- Dashboard: in-browser notifications for webhook deliveries. `GET /api/webhooks/stream` (session-authenticated SSE, scoped to the workspace, 10-minute lifetime) pushes a frame after each delivery attempt; the dashboard shows a toast (delivered / retrying / failed; the frame carries the delivery status `succeeded` / `pending` / `failed`) and, when permitted and the tab is hidden, a desktop notification.
- Dashboard: a Live events card on the Webhooks page shows the last 50 events (time, type, account, payload), with or without a registered endpoint: on load the newest stored events from `GET /api/webhooks/stream/recent` (session-authenticated, linked workspaces only; no payload, and no `upstream.*` or `webhook.test`, which are not stored), then each event as it arrives. The same stream now also carries `event: event` frames (`{ id, type, accountId, ts, data }`, `upstream.*` included) for linked workspaces; `POST /api/webhooks/stream/test` pushes a synthetic `webhook.test` event to the caller's workspace only (the card's Emit test event button).

- Webhook event `messages.deleted`, from OF's `chat_message_delete` socket frame (payload `{ id }`). It was
  `upstream.chat_message_delete` before; a value that is not a message id still is. Mapping:
  `docs/spec/plan-v6-ws-events.md`.
- Dashboard: Accounts → Connect account connects an OnlyFans account from a DevTools cURL, a nickname and a proxy URL, with plain-language hints for the upstream's errors; the dialog detects the Fastt Login Capture extension (links to its store page when missing). `POST /api/accounts/connect` (session + CSRF, linked workspaces only) forwards to the upstream's `/session/bootstrap` and passes its status and body through; the cURL is never written to the request log.
- Dashboard: the Playground shows each parameter's type, required marker, description and default from the spec, prefills `limit` (20) and date ranges (last 7 days), seeds JSON bodies from the request schema, remembers per-operation values and the last account (with Reset to defaults), lists recent operations and summaries in a collapsible sidebar, and adds Copy and a Table view for `rows`/`items`/`data` responses.
- Email verification on sign-up: a new account must open the emailed link before it can sign in (`403 EMAIL_NOT_VERIFIED` until then); the link signs it in and opens the dashboard, and the login page offers Resend verification email. Mail goes out over SMTP (new optional `SMTP_HOST`, `SMTP_PORT` (default 587, TLS on 465), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`); without `SMTP_HOST` the link is printed in the API log. Migration `0007` marks existing users verified, so nobody is locked out.

### Fixed
- Analytics backfill, before release: `purchase_fact.kind` is read from OF's `descriptionDetails.type` (`message`, `tips`, `post`, `subscription`, `subscription_prolong`); live transactions have no top-level `type`, so every row had kind NULL.
- Analytics backfill, before release: the range's transactions are read first; they were read last, after hours of chat walks, so no run lived to store them and `purchase_fact` stayed empty. A run stopped while reading them reports the transactions it stored.
- Analytics, before release: a live outbound message is stored as mass only when OF's `isFromQueue` is true, not whenever it has a queue id (every OF message has one, so every live DM would have been); boundary messages older than the mass window, read again, update every column but their mass and automated flags (a PPV bought later now shows as opened).
- An expired OF session is now reported: the upstream marks an account `session_expired` (and emits `accounts.session_expired` once, then stops its socket reconnects) when OF answers 401 to any call for it or 400 "Wrong user" (code 301), which used to loop every 30 s while `GET /of-accounts` kept reporting `active`; re-connecting the account clears it. The Accounts page shows "Session expired · re-connect" and hides Run analytics for it, and a backfill that gets a 401 fails with "OF session of account <id> expired: re-connect it in Accounts, then run the backfill again" and `errorCode: session_expired` on `GET /v1/stats/backfill`. Upgrade the upstream with the gateway.
- Stats routes, before release: a DM after an unanswered fan message is a late reply, not an opener (17 openers instead of 19 on a live 30 days); a month that does not exist in `from` or `to` is `400 validation_error`, not a 500; a script's sends and first and last send come from the same rows; scripts read only hashes of the current normaliser version; reads are bounded to the range with an exact lookback per chat.
- Analytics backfill: the chat list is paged by OF's `nextOffset` (OF answers about 10 chats a page whatever the `limit`); it advanced by 50 and skipped 43 of 62 active chats in a live week.
- Analytics backfill: `chats.csv` `fan_username` is filled from the chat list, now read with `skip_users=none`; it was always empty.
- Analytics backfill: a chat OF lists with `lastMessage: null` (its latest message deleted) is walked and counts as active; it was skipped, and its other messages in the range were missed (8 in a live week).
- Analytics backfill: a chat walk that ends on OF's empty last page (`{"list":[],"hasMore":false}`, after a last page of messages that still says `hasMore`) records `reached_start`; it did not, so such chats counted as incomplete (1,224 of 1,347 in a live 90-day run) and their openers as kind `unknown`.
- Analytics backfill: OF's chat list leaves some chats out while its offset counts them (pages of 20 places held 13 to 19 chats), so a fan with `isActive: false` who bought a PPV in the range was never walked. After the listed chats, a run now walks the range's payers and the chats with stored messages that the list did not name, and skips instead of failing the run a chat whose first messages page OF answers 404 (counted) or that the upstream answers another 4xx but 401 and 429 (its id printed). The chat list is read to its end, or to three pages in a row with no new chat; it stopped after two pages with no chat active in the range, but its order is not by last message (a mass message does not move a chat, and its tail is ordered by fan id). The CLI prints the seeded, 404, dropped (unreadable fan id) and failed counts.
- A Postgres restart no longer crashes the API or an analytics CLI: an idle pool connection's error is logged and the next query reconnects.

### Changed
- Analytics backfill: `messages.csv` `text_hash` is the script hash ([docs/analytics.md](docs/analytics.md#scripts)): the fan's names become `<name>` and it is empty for text too short to be a script. Automation matching still hashes the text without replacing names.
- Parity baseline lists `GET settings/welcome-message` (served since analytics step 0), so losing it fails `parity-audit check`.
- `OF_REQUIRE_PROXY` now defaults to `false` in the upstream, both compose files and the deploy env example: an account connected without a proxy uses the server's own IP. Set `true` to keep refusing proxy-less accounts.

- `posts.expired` is documented as firing for any post in the account's feed, not only its own: a socket capture
  showed OF sends `post_expire` for other creators' posts.
- `docs/webhooks.md`: `upstream.*` names and contents may change in any minor release.
- Analytics backfill: five chats in a row that OF refuses with its own 400 or 403 (its answer to a dead session's chat reads, e.g. "Wrong user") now end the run as `session_expired` with "re-connect it in Accounts, then run the backfill again"; a walked chat resets the count; another 4xx neither counts nor resets it. `GET /v1/stats/backfill` carries `failedChats` (chats skipped on a 4xx) and the Accounts page shows "Done · N chats failed" ([docs/analytics-backfill.md](docs/analytics-backfill.md#running-a-backfill)).
- Stats: turn and opener statuses (`breached`, `pending`, `no_reply`) are judged as of each account's last backfill (`account_workspace.refreshed_at`), or now when none has ended since migration `0015`, instead of always now: fan messages stored live after the last run, whose replies only a backfill reads, no longer turn into permanent breaches ([docs/analytics.md](docs/analytics.md#reply-time-metrics)).
- Analytics backfill: a payer of the range is walked even when the chat list names the chat as not active in the range (it was only walked when the list left it out), with the list's names, so a PPV bought in the range is read again with its `isOpened` when it is on the pages down to the range start.
- Analytics backfill: one run per account across processes. Each run holds a Postgres advisory lock on the account id (`pg_try_advisory_lock`) on its own connection for its whole length, so a second run of the same account, from the CLI, the dashboard or another API process, fails at once with `409 backfill_running` ("wait for it to end, then run again"); `POST /v1/stats/backfill` answers it before starting while `analytics:backfill` holds the account. It was only checked within one API process ([docs/analytics-backfill.md](docs/analytics-backfill.md#running-a-backfill)).
- Analytics backfill: requests are spaced evenly, one every 3,600,000 / `ANALYTICS_REQUESTS_PER_HOUR` ms (6 s at the default 600), instead of up to the hourly cap at once and then an idle wait; the hourly total, page delay and 429 backoff are unchanged.
- `analytics:backfill` prints a progress line to stderr every 5 minutes (phase, requests, chats done of total, ETA), and a run that fails prints its last counts and still writes the CSVs of what it stored, then exits 1.
- Error texts name the next step: a 429 past its retries names the retries and the cap (`ANALYTICS_REQUESTS_PER_HOUR`) and says to wait, then run again with a lower cap; a 502/503/504 or unreachable upstream past its retries says to check the upstream at `UPSTREAM_URL` (answering within `UPSTREAM_TIMEOUT_MS`) and its logs; an OF 400/403 outside a chat walk says to re-connect the account in Accounts if its session is dead. The proxy's `upstream_unavailable` and `upstream_timeout` messages are unchanged.

### Removed

- The upstream no longer forwards counter frames made of numbers and flags only, such as
  `{"hasSystemNotifications": …, "messages": …}`; they were sent as `upstream.hasSystemNotifications` and
  `upstream.messages`.

## [2.1.0] - 2026-10-05

v2.1 adds 41 named per-account operations of the reference API: rows 2.0 left open, and the content, promo and
settings groups. It is additive: the wrapper and `_pagination`, the webhook body, signature and event names, the
passthrough and the database schema are unchanged. The only env change is optional: compose now passes
`OF_REQUIRE_PROXY` through to the upstream (default `true`, same as before). The gateway and upstream images do not have to be
upgraded together; a 2.0 gateway forwards the new routes through its catch-all. Every reference route not listed
here stays reachable through `_of/{path}`, in OF's own paths and shapes, when OF has such a call.

### Added

Paths are relative to `/v1/{account}`.

- **Rows left open in 2.0** (1): `DELETE fans/{fan_id}/notes` (clears the note).
- **Content** (15): `POST posts`, `DELETE posts/{post_id}`, `GET posts/{post_id}/comments`; `GET` and
  `POST media/vault/lists`, `PUT`, `PATCH` and `DELETE media/vault/lists/{list_id}`,
  `POST media/vault/lists/{list_id}/media`; `GET stories`, `GET stories/archive`, `GET stories/highlights`,
  `DELETE stories/{story_id}`; `GET saved-for-later/messages`, `GET saved-for-later/posts`.
- **Promo** (8): `GET` and `POST tracking-links`, `DELETE tracking-links/{tracking_link_id}`; `GET trial-links`,
  `DELETE trial-links/{trial_link_id}`; `GET promotions`, `DELETE promotions/{promotion_id}`; `GET bundles`.
- **Settings** (6): `GET settings`, `POST settings/profile`, `GET settings/social-media-buttons`;
  `GET release-forms/taggable-users`; `GET notifications/counts`, `GET notifications/tabs-order`.

### Added (verified on one account)

These 11 GETs call an OF path derived from a known one. A read-only probe on one connected account is their only
evidence.

- **Rows left open in 2.0** (4): `GET chats/{chat_id}/messages/{message_id}`, `GET chargebacks`,
  `GET engagement/messages/direct-messages`, `GET engagement/messages/top-message`.
- **Content** (5): `GET posts/labels`, `GET media/vault/lists/{list_id}`, `GET stories/{story_id}`,
  `GET saved-for-later/messages/settings`, `GET saved-for-later/posts/settings`.
- **Settings** (2): `GET settings/blocked-countries`, `GET settings/drm`.

### Fixed

- `GET engagement/messages/mass-messages` and `GET mass-messaging/overview` no longer emit a looping
  `x-next-page`. OF ignores `offset` on the call behind them and always reports more, so a client following
  `_pagination.next_page` re-read page 1 forever; it now stops after page 1. Only clients that follow
  `_pagination.next_page` are fixed. A client that pages by hand with `offset` still gets page 1 for every offset
  and must stop when a page repeats the previous one. Refusing `offset` there with a `422` would break 2.0
  clients, so it waits for 3.0.0.

### Changed

- `GET settings` omits streaming-key fields: every top-level key of OF's settings whose name contains "stream"
  (any case) is dropped, because it can hold streaming credentials that any read-scope key could see.
- Every new route turns a `404`, `405` or `422` on its path into a success. Nothing else that 2.0 serves changes,
  apart from the fix above.

### Known gaps

- **Every write is fixture-tested only, never executed against OF**: `DELETE fans/{fan_id}/notes`, `POST posts`,
  `DELETE posts/{post_id}`, the five `media/vault/lists` writes, `DELETE stories/{story_id}`, `POST tracking-links`,
  the `DELETE` of tracking links, trial links and promotions, and `POST settings/profile`.
- **Write fields with no verified OF mapping answer `422 unsupported_field` when set**, rather than being dropped:
  OF can ignore a field silently, so a dropped `scheduledDate` or `saveForLater` would publish a post now. On
  `POST posts` only `text` and `mediaFiles` (vault ids) are sent; on `POST tracking-links`, `tags` is refused; on
  `POST settings/profile` only `about` is sent, and an empty body is a `422`. On create bodies, absent, `null`,
  `""`, `[]` and `false` count as unset.
- **`POST posts` treats `0` as a value, not as unset**: `expireDays`, `fundRaisingTargetAmount`, `votingDue` or
  `votingCorrectIndex` set to `0` is a `422`. Leave those fields out instead.
- **Narrowing filters answer `422 unsupported_field`** where OF's call cannot take them, instead of returning an
  unfiltered list: `query` on `media/vault/lists` and `engagement/messages/direct-messages`; `startDate`, `endDate`,
  `with_deleted`, `sortby` and `sort` on `tracking-links`; `startDate`, `endDate`, `sort` and `field` on
  `trial-links`; any `filter`, `sort` or `sortDirection` other than `all`, `date` and `desc` on
  `release-forms/taggable-users`. Cosmetic options (`synchronous`, `pagination`, `lightweight`, `skip_users`) are
  accepted and ignored. Routes that return one page answer `offset` above 0 with a `422`, and so do the reference's
  own cursors (`marker` on `stories/archive`, `sort=asc` on post comments).
- **`GET chargebacks`**: `limit` is refused with a `422` (OF's page size there is unverified), and so is `offset`
  above 0. OF pages by its own marker: a non-null `data.marker` means the list is truncated and more chargebacks
  exist.
- **`GET tracking-links`** clamps `limit` to 100, an unverified cap on OF's call. If OF caps lower, a page comes
  back short and carries no `next_page` although more links exist.
- **`GET stories/highlights`** returns OF's single answer; whether it holds every highlight is unverified.

## [2.0.0] - 2026-10-02

v2 makes the gateway a drop-in for clients of the reference API: its webhook event names, body and signature, and
its response shape on per-account routes. Every change below breaks 1.x clients; read
[Upgrading to 2.0](#upgrading-to-20) before you deploy.

### Added

- **Raw passthrough** `/v1/{account}/_of/{path}` reaches any OnlyFans call that has no named route yet, in OF's own
  paths and shapes.
- Webhook deliveries carry `X-OFAPI-Idempotency-Key`, the event's `evt_` id, which stays the same on retries and
  redeliveries. Deliveries expose it as `eventId`.
- The webhook catalogue accepts every in-scope event name of the reference API, each marked emitted, TBC or never
  (see [docs/webhooks.md](docs/webhooks.md#event-types)). New events emitted: `accounts.connected` and
  `accounts.reconnected`.
- A `dropped` delivery status, for pending 1.x deliveries the migration cancels.

### Upgrading to 2.0

**Upgrade the gateway and upstream images together.** The gateway drops event frames whose type it does not know,
so a mixed pair loses events until both run 2.0. The database migration runs on start.

- *Gateway 2.0 with upstream 1.x:* every renamed event is dropped as an unknown type (`posts.expired` and
  `accounts.session_expired` included); only `upstream.*` frames still arrive. 1.x frames have no `amount_cents`, so
  any amount would be stored as null. The 1.x paths (`users/me`, `vault/media`, ...) still work, but their
  responses come back wrapped.
- *Upstream 2.0 with gateway 1.x:* every stored event, `accounts.session_expired` included, is dropped as an
  unknown type, and the three renamed paths return 404 from the upstream.

1. **Webhook body.** `{"id","type","createdAt","accountId","data"}` is now `{"event","account_id","payload"}`, in
   that order. `account_id` is a JSON string, and is omitted for events without an account (`webhook.test`).
   There is no `id` or `createdAt` in the body any more. Client `/v1/ws` frames are the same JSON (the `ready`
   frame is unchanged).
2. **Signature.** The `webhook-id`, `webhook-timestamp` and `webhook-signature` (Standard Webhooks) headers are
   gone. Deliveries carry `Signature`: lowercase hex HMAC-SHA256 of the raw body, keyed with the endpoint's
   `whsec_...` secret string as-is (not base64-decoded). There is no timestamp and so no replay window. Existing
   secrets stay valid. De-duplicate on `X-OFAPI-Idempotency-Key` instead of `webhook-id`. See
   [docs/webhooks.md](docs/webhooks.md#verifying-the-signature).
3. **Event names are plural**, as in the reference API. The 1.x names are refused with `400`:

   | 1.x | 2.0 |
   |---|---|
   | `message.received` | `messages.received` |
   | `message.sent` | `messages.sent` |
   | `ppv.unlocked` | `messages.ppv.unlocked` |
   | `tip.received` | `tips.received` |
   | `subscription.new` / `.renewed` / `.expired` | `subscriptions.new` / `.renewed` / `.expired` |
   | `account.session_expired` | `accounts.session_expired` |
   | `post.expired` | `posts.expired` |

   The migration renames the names in stored endpoint `events` filters and in the event ledger (so `/v1/stats`
   returns the 2.0 names; use them in `?types=`). Pending deliveries of a renamed 1.x event are set to `dropped`
   and never sent, so no 1.x body goes out under a 2.0 name; finished deliveries keep their 1.x name as history.
   Neither can be redelivered (`409 not_redeliverable`; deliveries carry a `redeliverable` flag).
   Payloads changed too: they follow the reference API's examples (for instance `messages.received` carries the
   full OnlyFans message object), and amounts are no longer read from the payload. See the event table.
4. **Three per-account paths were renamed**, with no aliases: `users/me` is now `me`, `vault/media` is now
   `media/vault`, and `vault/media/{mediaId}` is now `media/vault/{media_id}`. The query parameters of the moved
   routes use the reference API's names: `chats` takes `limit` (1-50), `offset`, `order` (`recent`|`old`),
   `skip_users` (`all`|`none`), `filter` and `query`; `chats/{chat_id}/messages` takes `limit` (1-100), `order`
   (`desc`|`asc`), `first_id` (desc cursor) and `offset` (asc only); `posts` takes `limit` (1-100) and `offset`;
   `media/vault` takes `limit` (1-100), `offset`, `query`, `field`, `sort`, `type` (`all`|`photo`|`gif`|`video`|`audio`)
   and `list`. `/v1/{account}/_of/users/me` still returns OF's own body.
5. **Per-account responses are wrapped.** A `2xx` JSON response of a named `/v1/{account}/...` route is now
   `{"data": <1.x body>, "_meta": {}}`, plus `"_pagination": {"next_page": "<absolute URL>"}` when there is a next
   page. Errors, `204` and empty responses, the `_of` passthrough, and the team-level routes (`/v1/whoami`,
   `/v1/accounts`, `/v1/webhooks*`, `/v1/stats`) are not wrapped. `/openapi.json` documents the wrapped shapes.

## [1.0.0] - 2026-10-02

### Added

- **Webhooks.** `/v1/webhooks` API to create, list, update, pause and delete endpoints, list recent deliveries,
  send a test event and redeliver. Deliveries are signed with
  [Standard Webhooks](https://www.standardwebhooks.com) headers (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`) and a per-endpoint `whsec_` secret. Failed attempts are retried with backoff (30 s, 2 m,
  10 m, 1 h, 6 h); an endpoint that keeps failing is paused (circuit breaker) until it is re-enabled. Targets
  must be `https://`, and private, loopback and link-local addresses are refused. Finished deliveries are kept
  for 7 days. Only `webhook.test` is sent in this release; the other catalogue events arrive with the upstream
  event source. See [docs/webhooks.md](docs/webhooks.md).
- **Webhooks dashboard.** Webhooks page with endpoint list, create, pause and resume, and an endpoint detail page
  with deliveries, filters and redeliver.
- **Home "needs attention" list.** Paused and failing webhook endpoints, also returned by `/api/overview` as
  `pausedWebhooks` and `needsAttention`.
- **Logs search** also matches path and endpoint substrings; a `req_` id is still an exact lookup.
- **Per-key usage.** Key rows link to the usage page grouped by key.
- **Self-host deploy.** Multi-stage Docker image, production `deploy/docker-compose.yml` with Caddy (automatic
  TLS) and Postgres 17, migrations on start, a VPS deploy guide ([deploy/hostinger.md](deploy/hostinger.md))
  with backups, restore and an optional Cloudflare Tunnel, and a CI job that builds the image and smoke-tests the
  compose stack.
- `link-team` command to approve a workspace for the upstream, available in the image.
- Public README, `CONTRIBUTING.md`, `SECURITY.md`, issue and pull request templates, and this changelog.

### Changed

- The upstream is reached through an opaque adapter with one `UPSTREAM_TOKEN` (bearer) and an origin-only
  `UPSTREAM_URL`; see the README for the three calls it must answer.
- Each user has exactly one workspace. It is created on sign-up and, if that failed, on the next dashboard
  request, so the `403 no_workspace` error is gone.
- Migrations are compiled into the API build; dev tooling is kept out of the runtime image.

### Security

- Organization writes through the auth API (create, delete, invite, accept, member and role changes,
  set-active, leave, slug changes) are refused. Renaming the workspace is still allowed.
- Unique index on `member.user_id`, so a user cannot hold a second membership. The migration fails if an
  existing database already has a user with two memberships; remove the extra rows first.
- The API refuses to start in production with a plain `http://` public URL.
- Dev Postgres binds to loopback only; the production Postgres password is kept out of the connection URL.
- A pre-publish check (`scripts/prepublish-check.sh`) guards the repository against secrets and stray brand
  names.

## [0.1.0] - 2026-10-01

First working MVP.

### Added

- Sign-up and sign-in (better-auth) with one workspace per user.
- Scoped `gk_` API keys (`read` or `write`, optional account allowlist), stored as SHA-256 hashes; create,
  rename, rescope and revoke from the dashboard.
- Proxy from `/v1/{account}/...` to the upstream with a per-key rate limit; status, body and rate-limit headers
  pass through.
- Request logs with header and body redaction, 14-day retention, and a log detail page.
- Usage by day, key, account and endpoint; Home KPI cards.
- Playground that sends requests with the dashboard session and copies the curl.
- Merged OpenAPI document at `/openapi.json` and an interactive reference at `/docs`.
- Dashboard pages: Home, Accounts, API keys, Logs, Usage, Playground, Settings.
- Workspace isolation for keys, logs and usage; a workspace reaches the upstream only after the operator links it.
- CSRF protection on cookie-authenticated writes, pnpm workspace, Postgres via docker compose, CI, AGPL-3.0
  licence.
