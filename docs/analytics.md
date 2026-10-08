# Analytics: reply time, openers and scripts

Steps 1 to 3 of the [client stats ask](spec/future-client-story-ask.md#6-first-slice-account-and-shift-performance):
reply time and reply SLA, openers, and script candidates, computed from the analytics store that the
[step 0 backfill](analytics-backfill.md) fills, plus live message events (see [Live updates](#live-updates)). Nothing
is computed at ingest. Each request reads the stored messages
and applies the workspace's current windows, so a changed window applies to all history at once.

Every metric is `verified: false`. The formulas are built and tested, but nobody has checked them by hand in OF or
against an Infloww export yet (see [Morning checklist](#morning-checklist)). Openers and scripts are the least
certain.

## Routes

All routes are under `/v1` and take an API key (`Authorization: Bearer ...`) or the dashboard session, as for
[`/v1/stats`](authentication.md). They read the analytics tables only and never call the upstream.

| Route | What it returns |
|---|---|
| `GET /v1/stats/metrics` | The catalogue: each metric's `id`, `name`, formula in words (`description`), `unit` (`seconds`, `percent`, `count`), `groupings`, the config `windows` it reads, and `verified` |
| `GET /v1/stats/metrics/:id` | One metric as rows, one per group with at least one turn or opener. `format=csv` sends the same rows as `text/csv` |
| `GET /v1/stats/metrics/:id/samples` | Up to 20 turns or openers behind the metric's value, oldest first, with message ids and times to check in OF |
| `GET /v1/stats/config` | The workspace's windows and timezone, and `freshness` ([Live updates](#live-updates)). The first read creates the default row |
| `PUT /v1/stats/config` | Changes the given fields only and bumps `version`. Needs a `write` key |
| `GET /v1/stats/scripts` | Script candidates sent in the range, most sent first, with sends, reply rate and exact variants |

Query parameters:

| Parameter | Routes | Meaning |
|---|---|---|
| `from`, `to` | all but config | Days (`YYYY-MM-DD`) in the config timezone; `to` is inclusive. Default: the 30 days ending today. At most 366 days |
| `accountId` | all but config | One account; default every account the key may use |
| `groupBy` | metric, samples | `day` (default), `hour` (hour of day, `00` to `23`, all days together) or `account` |
| `format` | metric | `json` (default) or `csv` |
| `group` | samples | Only the turns or openers in this group (a row's `group`, e.g. `2026-09-14`) |
| `limit` | samples, scripts | Samples: 1 to 20, default 20. Scripts: 1 to 200, default 50 |

A turn is grouped by the time of its first fan message, an opener by its send time. Every response carries `asOf`,
`timezone` and `configVersion`; scripts also carry `normaliserVersion`. The same stored data, `asOf` and versions
give the same numbers.

Errors: `404 metric_not_found` for an unknown id; `400 validation_error` for a day that does not exist;
`400 invalid_range` when `from` is after `to`; `400 range_too_large` past 366 days.

### Scoping

- **Linked workspace only.** A workspace the operator has not linked (`link-team`) gets `409 team_not_linked` on
  every route.
- **Own rows only.** Every read is limited to rows of the key's workspace. A second workspace's key sees empty rows,
  even with `accountId` set to the first workspace's account.
- **Key allowlist.** A key with an account allowlist sees only those accounts; a key without one sees all of its
  workspace's accounts. `accountId` outside the allowlist is `403 account_not_allowed`.
- **Write scope.** `PUT /v1/stats/config` with a read-only key is `403 insufficient_scope`.

## Live updates

Between backfills, the upstream's `messages.received` and `messages.sent` events for a claimed account (one with an
`account_workspace` row) add the message's `message_fact` row, derived with the backfill's own mapper, and
`messages.deleted` removes it. Events for unclaimed accounts are ignored. The latency is the upstream's delivery over
its event socket (OF's own socket, then one hop to the gateway, usually seconds); events missed while the gateway is
down or reconnecting are not replayed, so a backfill is still the complete view. Only `message_fact` changes live,
and a row already stored is kept. The live mapper has no mass history, welcome message or automation texts, so an
outbound message with a `queueId` counts as mass and none counts as automated until a backfill over its range
re-derives the row. Scripts (the `script` table) and `chat_coverage` are backfill-only; the metrics read the new rows
on the next request. `GET /v1/stats/config` returns `freshness`: `lastLiveAt` (the newest message event's time, from
the event ledger), `liveEvents24h` and `lastBackfillAt` (the last backfill chat walk), over the claimed accounts in
the key's scope; the Stats page shows the first two under its header.

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

A turn has one of four statuses, set against `reply_cap` (default 12 h) and `asOf`:

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

Its **status**, against `open_reply` (default 24 h) and `asOf`:

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
within `open_reply` after the sequence's last DM, and `pending` while that window has not elapsed. So a script sent
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
`400 validation_error`; a known one is stored by its canonical IANA name.

```sh
curl -X PUT -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"slaSeconds": 600, "timezone": "Europe/Ljubljana"}' http://localhost:4000/v1/stats/config
```

## Deploy

1. **Migrate.** `pnpm db:migrate` applies `0009_stats_config` (table `stats_config`), `0010_scripts` (table `script`,
   `message_fact.normaliser_version`, `chat_coverage.fan_name` and `fan_custom_name`) and `0011_scripts_trim` (drops
   unused `script` columns).
2. **Rehash once per account.** Rows stored before `0010` have a null `normaliser_version` and an older
   `text_hash`, so scripts leave them out. For each claimed account run
   `pnpm --filter @gateway/api analytics:rehash --account <id>`. It is safe to run again: a second run updates
   nothing.
3. **Names.** Only backfills run after `0010` store the fan's name and custom name in `chat_coverage`. Until a chat is
   walked again, rehash replaces the username and the names on stored messages only. Re-run the backfill, then
   rehash, to use them.

## CLIs

Run from the repo root; in the container, `node dist/cli/analytics-<name>.js` with the same arguments. They read the
analytics tables only. `--from` is inclusive and `--to` exclusive; a date without a time is midnight UTC (unlike the
routes, whose `to` day is inclusive and in the config timezone). Windows come from the workspace's stats config.
`--team` is needed only when the account is not claimed. Keep the output out of the repo: it holds fan ids and
message text.

| Command | What it does |
|---|---|
| `pnpm --filter @gateway/api analytics:openers --account <id> --from <date> --to <date> --out <file.md> [--team <teamId>]` | Writes up to 20 openers of the range, spread evenly over it, each with the reason we think it is an opener |
| `pnpm --filter @gateway/api analytics:scripts --account <id> --from <date> --to <date> --out <file.md> [--team <teamId>]` | Writes the top 20 scripts by sends in the range, with reply rates and up to 5 exact variants each |
| `pnpm --filter @gateway/api analytics:rehash --account <id> [--team <teamId>]` | Rebuilds `text_hash` and `normaliser_version` of the account's outbound messages from their stored text, then records its scripts. Prints `outbound`, `updated` and `scripts` |

## Morning checklist

The hand check that `verified` waits for. The files come from the CLIs above, run over the backfilled 30 days:
`/tmp/step0/openers-samples.md` and `/tmp/step0/scripts-top20.md`. Log in to OF as the account. Check every row,
and write down for each one: OK, or wrong and what OF shows.

**Finding a message.** The chat id is the fan's user id: open `https://onlyfans.com/my/chats/chat/<chat id>/`. OF
does not show message ids. Scroll to the listed time (UTC; convert to your clock), or fetch the message through the
gateway to see its text and time: `GET /v1/<account>/chats/<chat id>/messages/<message id>`.

**Openers** (`openers-samples.md`), for each row:

1. The message at "Sent at" is a chatter's DM: not a mass message, not the welcome message, not an automation.
2. Before it, for the whole `open_gap` (7 days), there is no fan message and no DM. Mass and welcome messages may be
   there; the "Why" column counts them.
3. The last fan message or DM before it is a DM, not an unanswered fan message.
4. The kind fits. `reactivation`: the DM named in "Why" is there, at that time. `first_ever`: nothing but mass or
   welcome messages before it, back to the start of the chat. `unknown`: scroll back and note whether the chat has
   earlier history.
5. The fan reply, if listed, is the fan's first message after the opener, at that time.

**Scripts** (`scripts-top20.md`), for each script:

1. Read its variants. They should be one script: the same copy, differing only in the fan's name, case, spacing or
   HTML.
2. They must not be different offers: a different price, number or media means the normaliser merged too much.
3. Note texts you know are one script but appear as separate hashes (an edit, a typo): the normaliser splits too
   much there.
4. A script with 1 send in the range is expected when its other sends fall outside the range: in
   `GET /v1/stats/scripts` its `sendsAll` and `chatsAll` are then higher than `sends` and `chats`. With a key over
   all accounts a script has `sendsAll` of at least 5 and `chatsAll` of at least 3 (detection needs that on one
   account); lower all-time counts there are a wrong row. A key limited to some accounts may see less
   (see [Scripts](#scripts)).

**After.** Nothing flips `verified` yet; that is a later step. Send the notes to the developer. A wrong row needs its
chat id, message id and what OF shows, so the rule can be fixed and the CLIs re-run.
