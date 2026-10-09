# Analytics: reply time, openers and scripts

Steps 1 to 3 of the [client stats ask](spec/future-client-story-ask.md#6-first-slice-account-and-shift-performance):
reply time and reply SLA, openers, and script candidates, computed from the analytics store that the
[step 0 backfill](analytics-backfill.md) fills, plus live message events (see [Live updates](#live-updates)). Ingest only derives each live message's
row (as the backfill does); every metric is computed per request: each request reads the stored messages
and applies the workspace's current windows, so a changed window applies to all history at once.

Every metric is `verified: false`. The formulas are built and tested, but nobody has checked them by hand in OF or
against an Infloww export yet (the hand-check CLIs are parked on branch `infloww-diff-parked`). Openers and scripts are the least
certain.

## Routes

All routes are under `/v1` and take an API key (`Authorization: Bearer ...`) or the dashboard session, as for
[`/v1/stats`](authentication.md). They read the analytics tables only and never call the upstream, except
`POST /v1/stats/backfill`, which runs the [backfill](analytics-backfill.md#from-the-dashboard).

| Route | What it returns |
|---|---|
| `GET /v1/stats/metrics` | The catalogue: each metric's `id`, `name`, formula in words (`description`), `unit` (`seconds`, `percent`, `count`), `groupings`, the config `windows` it reads, and `verified` |
| `GET /v1/stats/metrics/:id` | One metric as rows, one per group with at least one turn or opener. `format=csv` sends the same rows as `text/csv` |
| `GET /v1/stats/metrics/:id/samples` | Up to 20 turns or openers behind the metric's value, oldest first, with message ids and times to check in OF |
| `GET /v1/stats/config` | The workspace's windows and timezone, and `freshness` ([Live updates](#live-updates)). The first read creates the default row |
| `PUT /v1/stats/config` | Changes the given fields only and bumps `version`. Needs a `write` key |
| `GET /v1/stats/scripts` | Script candidates sent in the range, most sent first, with sends, reply rate and exact variants |
| `GET /v1/stats/fans` | One row per fan (chat) with a stored message in the range, the latest fan message first (fans who wrote nothing in the range last), then the latest message: `accountId`, `chatId` (the fan's user id), `fanUsername` (from the chat list; null when not seen), `fanMessages`, `dmMessages` (outbound, not mass, not automated), `massMessages`, `automatedMessages` (outbound, automated, not mass; the four counts sum to all the fan's messages in the range), `firstAt`, `lastAt`, `lastFanAt` (null when the fan wrote nothing in the range), and `ppvSent`, `ppvOpened`, `tips`, `tipCents` ([below](#stored-messages-and-export)). `total` is the number of fans before `limit` ([Stored messages and export](#stored-messages-and-export)) |
| `GET /v1/stats/messages` | The stored messages, by account, chat, time and message id, each with the fields listed in [Stored messages and export](#stored-messages-and-export); `truncated` is true when `limit` cut the list, and then `nextCursor`, passed as `cursor`, returns the next page (`400 invalid_cursor` for a malformed one). `format=csv` streams every message in the range as `text/csv` (snake_case columns) |
| `GET /v1/stats/revenue` | Gross and net by kind and by day, payers, fan CVR, the golden ratio, DM PPV unlocks, and the top 50 payers, from the stored transactions and messages ([Revenue](#revenue)) |
| `POST /v1/stats/backfill` | Body `{ accountId, days? }` (`days` 1 to 366, default 30). Claims the account for the workspace and backfills `now - days` to now in the background, without CSVs; `202 { runId }`. Needs a `write` key or the dashboard session |
| `GET /v1/stats/backfill?accountId=` | The account's last backfill run since the API started: `status` (`queued`, `running`, `done`, `error`), `from`, `to` (when it was asked for: it reads up to when it starts), `startedAt`, `finishedAt`, `runId`, `requests`, `retries` (after a transient upstream failure), `chats` (walked), `messages` (stored), `failedChats` (chats skipped on a 4xx), `error`, `errorCode` (`session_expired` when OF refused the account's session or refused 5 chats in a row with its 400 or 403, else null); or `{ "status": "idle" }` |

Query parameters:

| Parameter | Routes | Meaning |
|---|---|---|
| `from`, `to` | all but config | Days (`YYYY-MM-DD`) in the config timezone; `to` is inclusive. Default: the 30 days ending today. At most 366 days |
| `accountId` | all but config | One account; default every account the key may use |
| `groupBy` | metric, samples | `day` (default), `hour` (hour of day, `00` to `23`, all days together) or `account` |
| `format` | metric, messages | `json` (default) or `csv` |
| `chatId` | messages | One fan's chat; default every fan in scope |
| `direction` | messages | `all` (default), `in` (the fans' messages only) or `out` (the creator side: DMs, mass and automated) |
| `group` | samples | Only the turns or openers in this group (a row's `group`, e.g. `2026-09-14`) |
| `limit` | samples, scripts, fans, messages | Samples: 1 to 20, default 20. Scripts: 1 to 200, default 50. Fans: 1 to 1000, default 200 (`total` shows how many there are). Messages: 1 to 5000, default 1000, JSON only (`truncated` shows a cut and `nextCursor` pages past it; the CSV is never cut) |

A turn is grouped by the time of its first fan message, an opener by its send time. Every response carries `asOf`,
`timezone` and `configVersion`; scripts also carry `normaliserVersion`. The same stored data, `asOf` and versions
give the same numbers. Turn, opener and script sequence statuses are judged as of each account's last backfill
([status time](#reply-time-metrics)), not `asOf`.

Errors: `404 metric_not_found` for an unknown id; `400 validation_error` for a day that does not exist;
`400 invalid_range` when `from` is after `to`; `400 range_too_large` past 366 days.

### Scoping

- **Linked workspace only.** A workspace the operator has not linked (`link-team`) gets `409 team_not_linked` on
  every route.
- **Own rows only.** Every read is limited to rows of the key's workspace. A second workspace's key sees empty rows,
  even with `accountId` set to the first workspace's account.
- **Key allowlist.** A key with an account allowlist sees only those accounts; a key without one sees all of its
  workspace's accounts. `accountId` outside the allowlist is `403 account_not_allowed`.
- **Write scope.** `PUT /v1/stats/config` and `POST /v1/stats/backfill` with a read-only key are `403 insufficient_scope`.
- **Backfill.** `POST /v1/stats/backfill` takes an account the caller sees in `GET /v1/accounts` (else `404 not_found`);
  one another workspace owns is `409 account_workspace_conflict`, and one with a run queued or running (in this API,
  or holding the account's backfill lock in another process, such as `analytics:backfill`) is `409 backfill_running`. `GET /v1/stats/backfill` shows only the caller's workspace's runs.

### Stored messages and export

Messages are stored per fan in `message_fact`, keyed by account and fan (`chat_id`), for the ranges a backfill read
and for the live message events received while the gateway was connected; a range never backfilled, or events missed
while it was down, are not there. `raw` keeps OF's message object (text, sender, price, media metadata); the media
files themselves are not stored. The retention jobs purge only the request log, webhook deliveries and the event
ledger, never the analytics tables. `fanUsername` comes from the chat list a backfill walks, so it is null for a chat
only seen live until a backfill walks it.

**Unsent messages.** A `messages.deleted` event (the fan or the creator unsent the message) keeps the row and sets
`message_fact.deleted_at` to the time the gateway applied the event (migration `0012`); a second event keeps the
first time, and an event for a message not stored does nothing. A backfill that reads the message again (so it still
exists upstream) clears the mark. Deleted messages stay in everything else: the fans list counts, reply time,
openers and scripts (the message was sent and seen); the export shows `deletedAt`.

The owner reports Infloww's fan-reply export is poor. To export the fans' own messages, call
`GET /v1/stats/messages?from=2026-09-01&to=2026-09-30&direction=in&format=csv`, with `accountId` and `chatId` to narrow
it; `direction=all` gives the whole conversation. The Stats page's Fans card has the same downloads, for the page's
account and range and per fan, and the Conversations page shows one fan's thread (up to 366 days ending at the range's end) with that fan's CSV; it hides by default the mass messages not bought as of the last read (`isMass`, unless priced and `isOpened`; both flags as stored by the last backfill that read the message, or by the live event that stored it). The CSV is plain UTF-8 with LF line endings, like the metric CSV; fields are quoted
only when they hold a comma, quote or line break, and the text is not otherwise altered. pandas reads it directly
(`pd.read_csv`); in Excel, open it with Data > From Text/CSV and pick UTF-8, so emoji and accents show. `text` is the
message as plain text: block and break tags (`p`, `div`, `br`, `li`, `tr`, `h1` to `h6`) become a space, other tags
(`b`, `i`, `a`, `span`…) are removed without one, HTML entities are decoded, whitespace is collapsed to single spaces
and case is kept. The CSV holds the whole range, without `limit`: it is streamed, read from the database 2000 rows
at a time.

Each message carries, as JSON fields (CSV columns in snake_case, in this order): `accountId`, `chatId`, `fanUsername`,
`messageId`, `createdAt`, `direction` (`inbound` = the fan's), `text`, `priceCents`, `isFree`, `isOpened`, `isTip`,
`tipCents`, `mediaCount`, `photos`, `videos`, `gifs`, `audios`, `hasPreview`, `isMass`, `isAutomated`, `automatedReason`
(`welcome`, `automation`, or null when not automated; empty in the CSV), `isReply`, `isLiked`, `deletedAt` (ISO time, or
null; empty in the CSV). `isOpened` and `tipCents` are stored columns (the one-time fill
of migration 0013 handles JSON numbers; rows are re-derived by the next backfill that reads them); the other detail fields are read from OF's stored message object
(`raw`) when the export runs, so no backfill is needed for messages already stored:

| Field | OF field | Notes |
|---|---|---|
| `priceCents` | `price` (dollars) | Stored column; a PPV is an outbound message with a price. |
| `isFree` | `isFree` | |
| `isOpened` | `isOpened` | Stored column. On a priced message, the fan bought it (OF's `canPurchaseReason` is then `opened`). OF reports it false on free messages. |
| `isTip`, `tipCents` | `isTip`, `tipAmount` (dollars) | A tip message has `price` 0 and the amount in `tipAmount`; `tipCents` (stored column) is 0 when not a tip or `tipAmount` is not a number or numeric string, as for `price`; the one-time fill of migration 0013 handles JSON numbers only, and rows are re-derived by the next backfill that reads them. |
| `mediaCount` | `mediaCount`, else `media` length | Stored column. |
| `photos`, `videos`, `gifs`, `audios` | `media[].type` (`photo`, `video`, `gif`, `audio`) | Counts only; the files are not stored. A GIPHY gif (`giphyId` set) adds 1 to `gifs` and is not in `mediaCount`, as in OF. Other types count only in `mediaCount`. |
| `hasPreview` | `previews` | Not empty: some media ids are shown free before purchase. |
| `isReply` | `replyToMessage` | An object: the message quotes another. |
| `isLiked` | `isLiked` | The other side liked it (on an outbound message, the fan). |

`GET /v1/stats/fans` adds per fan, over the same range: `ppvSent` (outbound, not mass, priced), `ppvOpened` (of those,
`isOpened`), `tips` (the fan's tip messages) and `tipCents` (their `tipAmount`). The Fans card shows PPV as
bought/sent and Tips as count and amount. These come from the message objects in the chat, not from transactions:
a PPV bought or a tip sent outside the stored messages is not in them.

### Revenue

`GET /v1/stats/revenue` (and the dashboard's Revenue page) sums the transactions the backfill stored in
`purchase_fact` (OF's `/payouts/transactions`; live events add none, so a range never backfilled shows nothing, and
the [hourly transactions poll](#keeping-it-fresh) adds the last 48 hours when it is on) and
counts PPV sends in `message_fact`. Gross is booked sales: OF's status `done` plus `loading`; `undo` (refunded) and
`pending_return` (being reversed) are left out of every sum, payer and name. Money is in cents, integers, USD (every
stored transaction is): `gross` is OF's `amount`, `net` its `net` (a missing one counts as 0). Rates are percent, null
when the denominator is 0. `fansMessaged` counts only the accounts in scope with a booked sale in the range: an
account whose transactions were never backfilled (or that sold nothing) would add fans against no payers, so with all
accounts selected it is left out of Fan CVR. `dmMessages`, `dmPpvs` and `ppv` count every account in scope.

- `totals`: `gross`, `net`, `transactions`; `settledGross`, the gross of status `done`, and `pendingGross`, of status
  `loading` (OF still holds it; the dashboard shows both under Gross; they add up to `gross`); `payers`, the fans with a transaction in the range whose fan is known;
  `fansMessaged`, the fans (chats) with a message in the range that is not unsent, from either side; `fanCvr`,
  `payers / fansMessaged` (a payer need not have been messaged, so it can pass 100). Payers and fans count per account:
  a fan on two accounts counts twice. `dmMessages`, the DMs sent (outbound, not mass, not automated; unsent ones
  count), `dmPpvs`, the priced ones of them (so automated PPVs are left out too, as in Infloww), and `goldenRatio`, `dmPpvs / dmMessages` (Infloww's golden ratio: Direct
  PPVs sent ÷ Direct messages sent, [infloww-definitions](spec/infloww-definitions.md)).
- `byKind`: per OF transaction type (`descriptionDetails.type`: `message`, `tips`, `subscription`,
  `subscription_prolong`, `post`; `unknown` when absent), `transactions`, `gross`, `net`, most gross first.
- `byDay`: every day of the range in the config timezone, zeros included.
- `ppv`: over PPV DMs (outbound priced messages, not mass; automated ones count): `sent`, `opened` (`isOpened`) and
  `rate`. Mass PPVs are not rated: OF's history keeps only the mass copies a fan bought, so their rate is always 100. Unsent
  PPVs still count as sent, as in `GET /v1/stats/fans`; a fan who bought before the unsend keeps it. `isOpened` is
  OF's flag (bought) as of the last read. The rate is an upper bound: a PPV unsent before anyone bought it vanishes
  from OF's history, so a backfill never stores it (only a live event before the unsend does) and it is missing from
  `sent`, while a bought one stays.
- `topPayers`: the 50 (account, fan) pairs with the most gross, with `accountId`, `fanId`, `name` (OF's display name,
  else username, on the fan's newest transaction that has one; null when none does), `gross`, `net`,
  `transactions`, `lastAt`, `isDeleted` (OF's `user.isDeleted` on that same transaction: the fan deleted their OF
  account, as of the backfill that stored it; the dashboard shows "deleted account") and `hasChat` (a message of the
  fan's chat on that account is stored, at any time).
- `withoutChat`: `payers` and `gross` of every payer of the range (not only the top 50) with no stored chat; the
  dashboard shows it above the top payers. On the live account most of them are deleted accounts.

## Live updates

Between backfills, the upstream's `messages.received` and `messages.sent` events for a claimed account (one with an
`account_workspace` row) add the message's `message_fact` row, derived with the backfill's own mapper, and
`messages.deleted` marks it deleted ([unsent messages](#stored-messages-and-export)). Events for unclaimed accounts are ignored, and `chat_queue.finished` (a finished broadcast, [webhooks](webhooks.md)) changes no analytics (`message_fact`); it is only counted in the event ledger's `GET /v1/stats`. The latency is the upstream's delivery over
its event socket (OF's own socket, then one hop to the gateway, usually seconds; `messages.sent` is polled
([webhooks](webhooks.md))); events missed while the gateway is
down or reconnecting are not replayed, so a backfill is still the complete view of the messages that exist. It
cannot see unsends: an unsent message vanishes from OF's history, so a `messages.deleted` missed while the gateway was
down is never applied, and `deleted_at` null means "no unsend event seen", not "not unsent". Only `message_fact` changes live,
and a row already stored is kept. Live outbound rows are DMs; mass messages and queued single DMs are stored only by a backfill. A live row's `isOpened` is OF's flag when the event arrived (false on a PPV just sent) and no purchase event updates it, so a PPV bought since reads not bought until a backfill reads the message again. The live mapper has no
welcome message or automation texts either, so no live message counts as automated until then. Scripts (the `script` table) and `chat_coverage` are backfill-only; the metrics read the new rows
on the next request. `GET /v1/stats/config` returns `freshness`: `lastLiveAt` (the newest message event's time, from
the event ledger), `liveEvents24h` and `lastRefreshAt` (the newest `account_workspace.refreshed_at`, the start of the
newest backfill that read up to now: [Keeping it fresh](#keeping-it-fresh)), over the claimed accounts in the key's scope, and
`nextRefreshAt`, the next daily refresh time (null when `STATS_REFRESH_HOUR_UTC` is unset). The Stats, Revenue and
Conversations pages show them under their range: "Live: last message event 5m ago · 4 events last 24h", then
"Backfill: refreshed 6h ago · next after 03:00 UTC" (the job ticks hourly from the API's start, so the run starts
within the hour after that time; "not refreshed yet" before any backfill has ended since migration
`0015`; "next: off" with the refresh off).

## Keeping it fresh

Off unless `STATS_REFRESH_HOUR_UTC` is set (an hour, 0 to 23, UTC; unset, empty or blank = off, and there is no default,
since these jobs call OF on their own). They are in-process jobs, so they also need `RUN_JOBS=true` (the default).

- **Hourly transactions poll.** Every hour (and once at API start), for each claimed account (`account_workspace`
  row), the transactions of the last 48 hours, read with the backfill's own reader and mapper and upserted into
  `purchase_fact` on `(account_id, tx_id)`, so a sale shows up on Revenue within about an hour of OF listing it
  (OF's ledger lags real time by hours, which the 48 hours cover). One request per account per hour (more only when
  those 48 hours hold over 100 transactions), with no pacing, retry or lock beyond that; an account that fails (a
  dead session, the upstream down) is logged (`transactions poll failed`) and tried again next hour. The socket's
  frames carry no transaction id or net, so this poll, not the live events, is the source of sales.
- **Daily refresh.** Ticked every hour (and once at API start). Once the current time is past today's
  `STATS_REFRESH_HOUR_UTC`:00 UTC, each claimed account whose `account_workspace.refreshed_at` is null or before that
  time is due and gets one backfill ([analytics-backfill.md](analytics-backfill.md#running-a-backfill)) from
  max(now - 7 days, `refreshed_at` - 1 hour) to now. It starts like the dashboard's Run analytics (queued behind the
  one-account-at-a-time limiter, its status on the Accounts page, `GET /v1/stats/backfill`) and the job does not wait
  for it. The run walks the window's payers even when the chat list names them as not active in the window, so a PPV
  bought in the window is read again with its `isOpened` when it is on the payer's pages down to the window start (a
  PPV older than those pages is not). One attempt per account a day: a run that ends moves `refreshed_at` forward,
  so the account is not due again until tomorrow's refresh time, and an account whose last run started after today's
  refresh time is skipped until then too, so a run that fails (a dead session, the upstream down, `backfill_running`
  while the CLI backfills it) is tried again the next day, from `refreshed_at` - 1 hour (at most 7 days back). That
  skip, like all run state, is in memory, so an API restart forgets it (one more attempt) and ends a run in flight
  (the next tick starts it again: rows upsert). A quiet
  week costs about 0.6 to 1 hour of requests per account at the default cap, a busy one 2.5 to 4.5 hours.

`account_workspace.refreshed_at` is the start of the newest run that read up to now (chats are walked over hours, so the next window overlaps by 1 h). A run that reads up to now is a dashboard or refresh run
(each reads up to its own start, later than the request when it was queued) or a CLI run whose `--to` is not before
its start; it counts once it ran to its end and stored its rows (not a dry run, not a stopped or failed run). A run
of an older range does not move it, and it never moves back. To see it:
`SELECT account_id, refreshed_at FROM account_workspace ORDER BY account_id;`

## Terms

As in [section 2 of the spec](spec/future-client-story-ask.md#2-what-we-can-measure). Messages in a chat are ordered
by `(createdAt, id)`.

- **Mass**: an outbound message whose queue id is a broadcast sent to more than one fan.
- **Automated**: an outbound message that matches the OF welcome message or a text from the client's automation
  list (`--automation` on the backfill).
- **DM**: an outbound message that is neither mass nor automated.
- **Fan turn**: the fan messages in one chat from the first fan message after a DM up to the next DM. Mass and
  automated messages do not end a turn. The DM that ends it is the **reply**.

## Reply time metrics

A turn has one of four statuses, set against `reply_cap` (default 12 h) and the **status time**: the account's
`account_workspace.refreshed_at` (the start of its newest backfill that read up to now, [Keeping it fresh](#keeping-it-fresh)), or the
request's `asOf` (now) when no backfill has ended since migration `0015`. Live events add fan messages after the last
backfill but the account's own messages only as `messages.sent` delivers them, so judged as of now a fan message after
the last run could read `breached` for good although it was answered; as of the status time it is `pending` until a
backfill reads the chat again. Openers are judged as of the same time, so a fan reply stored after it counts at the
next backfill (until then the opener is `pending` or, once `open_reply` has elapsed at the status time, `no_reply`);
so are [script](#scripts) sequences.

| Status | Meaning |
|---|---|
| `in_cap` | Replied within `reply_cap` of the turn's first fan message |
| `late` | Replied after `reply_cap` |
| `breached` | No reply, and `reply_cap` has elapsed |
| `pending` | No reply yet, and `reply_cap` has not elapsed |

A turn that started before `from` is not counted, even when its reply falls in the range. A late reply is found
however long after the cap it comes.

| Id | Unit | Formula |
|---|---|---|
| `reply_time` | seconds | Median wait from the turn's first fan message to its reply, over `in_cap` turns only. Late, breached and pending turns are counted beside it, not in it |
| `reply_time_p90` | seconds | 90th percentile of the same waits as `reply_time` (`in_cap` turns, same `n`), by linear interpolation between closest ranks. Late, breached and pending turns are counted beside it, not in it |
| `reply_time_mean` | seconds | Mean wait from the turn's first fan message to its reply, over every replied turn (`in_cap` and `late`). Unreplied turns are left out. Comparable to Infloww's reply time |
| `reply_time_mean_last` | seconds | As `reply_time_mean`, but timed from the last fan message before the reply. Infloww's other possible turn start ([definitions §8](spec/infloww-definitions.md#8-local-evidence-added-2026-10-05)) |
| `reply_sla` | percent | Turns replied within `sla` (default 15 min), divided by turns that are not pending (replied, or breached). Breached turns count against it |
| `reply_time_substantive` | seconds | As `reply_time`, but only a DM of `min_reply_chars` or more (default 15) ends a turn. A shorter DM ("one sec babe") does not stop the clock, so the turns themselves differ from `reply_time` |

Text length for `min_reply_chars` is counted in characters (code points) after the text normaliser: tags stripped,
HTML unescaped, NFKC, lowercase, whitespace collapsed.

Infloww reports a mean over replied turns with no known cap
([definitions §1](spec/infloww-definitions.md#1-reply-time)). That is why both mean variants exist. The median is
our own number: one overnight wait does not move it.

Rows of a reply time metric carry `value`, `n` (turns behind the value), `turns`, `inCap`, `late`, `breached`,
`pending` and `slaMet`. CSV columns: `group,value,n,turns,in_cap,late,breached,pending,sla_met`. A sample carries
`fanMessageId`, `fanAt`, `lastFanMessageId`, `lastFanAt`, `replyMessageId`, `replyAt`, `waitSeconds`,
`waitFromLastSeconds`, `status` and `slaMet`.

## Opener metrics

An **opener** is a DM where, in that chat:

1. there is no fan message and no DM in the `open_gap` (default 7 days) before it; mass and automated messages
   (the welcome message included) do not reset the gap, and
2. the last fan message or DM before it, if any, is a DM. If the fan wrote last, the DM is a late reply, however
   long the gap: the fan wrote first.

Its **kind**:

| Kind | Meaning |
|---|---|
| `first_ever` | Nothing but mass or automated messages is stored before it, and the backfill walked the chat to its start |
| `reactivation` | An earlier DM is stored, `open_gap` or more before it |
| `unknown` | Nothing earlier is stored, and the walk did not reach the chat's start, so the gap runs off our coverage |

Its **status**, against `open_reply` (default 24 h) and the status time ([above](#reply-time-metrics)):

| Status | Meaning |
|---|---|
| `replied` | The fan's first message after it came within `open_reply` |
| `no_reply` | No fan message within `open_reply`, and the window has elapsed |
| `pending` | No fan message yet, and the window has not elapsed |

| Id | Unit | Formula |
|---|---|---|
| `openers` | count | Openers sent in the range, with counts by kind and by status |
| `opener_reply_rate` | percent | Openers `replied`, divided by openers `replied` or `no_reply`. Pending openers are counted beside it, not in it |
| `opener_reply_rate_substantive` | percent | As `opener_reply_rate`, but only a fan message of `min_reply_chars` or more (default 15) is a reply, so "ok" is not |
| `opener_fan_reply_time` | seconds | Median time from an opener to the fan's first message after it, over `replied` openers |

Rows of an opener metric carry `value`, `n`, `openers`, `firstEver`, `reactivation`, `unknownKind`, `replied`,
`noReply`, `pending` and `massOrAutomatedGap` (openers whose gap held mass or automated messages, which did not reset
it). CSV columns:
`group,value,n,openers,first_ever,reactivation,unknown_kind,replied,no_reply,pending,mass_or_automated_gap`.
A sample carries `openerMessageId`, `sentAt`, `kind`, `previousMessageId` and `previousAt` (the DM before it),
`gapSeconds`, `massOrAutomatedInGap`, `fanReplyMessageId`, `fanReplyAt`, `fanReplySeconds` and `status`. For
`opener_reply_rate_substantive`, the fan reply is the fan's first message of `min_reply_chars` or more.

## Scripts

A **script** is a DM text that, after the script normaliser, was sent 5 or more times in 3 or more chats within 30
days of each other, on one account. Detection is automatic only; registering scripts by hand is not built.

The script normaliser, version 1:

1. Strip HTML tags (each becomes a space), then unescape HTML entities.
2. Unicode NFKC, lowercase, collapse whitespace.
3. Replace the fan's name, username and custom name (the account's nickname for the fan) with `<name>`, as whole
   words, longest first. Names shorter than 2 characters are left alone.
4. Numbers, emoji, prices and punctuation stay, so different offers stay apart.

A text is eligible only if the result has 4 or more words or 20 or more characters, so "hey" and empty captions do
not collide. The hash is SHA-256 of the result, first 16 hex characters. It is stored on every outbound message as
`text_hash`, with `normaliser_version`. Only hashes of the current version are compared.

Being a script is decided over all stored messages of the account, not the range: the qualifying 30 days may fall
outside the requested range. The backfill and `analytics:rehash` record each script found in the `script` table.
`GET /v1/stats/scripts` then lists those scripts with their sends in the range, so a script can show 1 send in a
range when its other sends fall outside it; `sendsAll` and `chatsAll` count all stored DM sends of the hash over the accounts in scope (the same population script detection reads), in range or not; a key limited to some accounts may see fewer.

Per script:

| Field | Meaning |
|---|---|
| `sends`, `chats` | Sends in the range, and the distinct chats they went to |
| `sendsAll`, `chatsAll` | Sends and distinct chats over all stored DM sends of the hash over the accounts in scope (the same population script detection reads), in range or not; a key limited to some accounts may see fewer |
| `firstSentAt`, `lastSentAt` | First and last send in the range |
| `sequences`, `replied`, `noReply`, `pending` | Outbound sequences holding a send in the range, by status |
| `replyRate` | `replied` divided by `replied` plus `noReply`, in percent; null when none is decided |
| `substantive*` | The same, counting only a fan message of `min_reply_chars` or more as a reply |
| `variantCount`, `variants` | Distinct exact texts sent (raw, HTML included), and up to 5 of them with counts, most sent first |

An **outbound sequence** is a run of DMs in one chat with no fan message between them; mass and automated messages
neither join nor end it. A sequence counts once per script it holds. It is `replied` when a fan message arrives
within `open_reply` after the sequence's last DM, and `pending` while that window has not elapsed at the account's
[status time](#reply-time-metrics). So a script sent
as several parts is not penalised for its first parts. Reply rate describes what happened after a send; it does not
show the script caused it. There is no money in this step.

## Windows

`stats_config` holds one row per workspace. The first read creates it with the defaults.

| Column (JSON field) | Default | Unit | Used by |
|---|---|---|---|
| `reply_cap_seconds` (`replyCapSeconds`) | 43200 (12 h) | seconds | reply time statuses, SLA |
| `sla_seconds` (`slaSeconds`) | 900 (15 min) | seconds | `reply_sla` |
| `min_reply_chars` (`minReplyChars`) | 15 | characters | substantive variants |
| `open_gap_seconds` (`openGapSeconds`) | 604800 (7 d) | seconds | openers |
| `open_reply_seconds` (`openReplySeconds`) | 86400 (24 h) | seconds | opener status, script reply rate |
| `convert_seconds` (`convertSeconds`) | 259200 (72 h) | seconds | stored only; opener conversion is not built |
| `timezone` | `UTC` | IANA name | `from`/`to` days, day and hour groups |
| `version` | 1 | | bumped by every `PUT`; results cite it as `configVersion` |

`PUT /v1/stats/config` takes any of the JSON fields above except `version`. Windows are whole seconds from 1 to 90
days; `minReplyChars` is 0 to 10000. `sla` may not exceed `reply_cap` (`400 invalid_config`). An unknown timezone is
`400 validation_error`, and so is a UTC offset like `+02:00` (Node reads it as two hours east of UTC, Postgres as two
hours west, which would shift every day by four hours; use an IANA name like `Europe/Ljubljana`); a known one is
stored by its canonical IANA name.

```sh
curl -X PUT -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"slaSeconds": 600, "timezone": "Europe/Ljubljana"}' http://localhost:4000/v1/stats/config
```

## Deploy

1. **Migrate.** `pnpm db:migrate` applies `0009_stats_config` (table `stats_config`), `0010_scripts` (table `script`,
   `message_fact.normaliser_version`, `chat_coverage.fan_name` and `fan_custom_name`) and `0011_scripts_trim` (drops
   unused `script` columns). `0012_message_deleted_at` adds the nullable `message_fact.deleted_at`; existing rows
   stay not deleted, and rows a live `messages.deleted` removed before it are gone.
   `0013_message_tip_opened` adds `message_fact.tip_cents` and `is_opened` and fills them once from `raw`.
   `0015_account_refreshed_at` adds the nullable `account_workspace.refreshed_at` ([Keeping it fresh](#keeping-it-fresh));
   it stays null until the next backfill of the account ends.
2. **Rehash once per account.** Rows stored before `0010` have a null `normaliser_version` and an older
   `text_hash`, so scripts leave them out. For each claimed account run
   `pnpm --filter @gateway/api analytics:rehash --account <id>`. It is safe to run again: a second run updates
   nothing.
3. **Names.** Only backfills run after `0010` store the fan's name and custom name in `chat_coverage`. Until a chat is
   walked again, rehash replaces the username and the names on stored messages only. Re-run the backfill, then
   rehash, to use them.

## CLIs

Run from the repo root; in the container, `node dist/cli/analytics-<name>.js` with the same arguments. It reads and
writes the analytics tables only. `--team` is needed only when the account is not claimed.

| Command | What it does |
|---|---|
| `pnpm --filter @gateway/api analytics:rehash --account <id> [--team <teamId>]` | Rebuilds `text_hash` and `normaliser_version` of the account's outbound messages from their stored text, then records its scripts. Prints `outbound`, `updated` and `scripts` |
