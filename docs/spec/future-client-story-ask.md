# Client story: account and shift performance stats

Status (2026-10-06): design sketch written 2026-10-02 and revised the same day after three reviews; step 0 backfill
built (`apps/api/src/modules/analytics`, the `analytics:claim`, `analytics:backfill` and `analytics:diff` CLIs,
[docs/analytics-backfill.md](../analytics-backfill.md)); a live last-7-days run on one account after the chat-list
fixes took 92 requests (13 chat-list pages) in 268 s and listed 63 chats (all 62 known active plus one mass-only
chat) with every fan username filled, 490 messages (463 inbound, 5 DM, 22 mass) and 0 transactions; the Infloww diff
awaits the client's export. Steps 1–3 built 2026-10-06 (compute only; openers and scripts unverified;
[docs/analytics.md](../analytics.md)); 30-day live run 2026-09-06..2026-10-06: 259 requests, 12 min, 87 chats, 9150
messages, 1286 turns, 7 incomplete chats; median reply time 1889 s, SLA met 27.4%, 17 openers, 5 script candidates.
Follow-up 2026-10-06: p90 reply time, substantive opener reply rate, `massOrAutomatedGap` counts and script all-time
totals shipped; openers and scripts still unverified (morning check pending).
Completeness (6.1) checked 2026-10-06 with `--dry-run`, messages 2026-09-29..10-06 and transactions 2026-09-06..10-06:
per-chat differences explained (late arrivals, fan deletions), the deleted-last-message chat gap fixed in code (not
re-run live), one documented quiet-page miss, transactions vacuous (0 = 0).
Feeds the user-designable statistics page in [FUTURE.md](../../FUTURE.md) and [handoff Phase 3](handoff-of-serving.md).

## 1. The ask

> We run chatters across several OnlyFans accounts and want to know what is working. Give us pretty much everything
> you can get: which scripts chatters send and how they perform, opening messages (the first message to a fan and
> what happens after), average reply time, and anything else that shows performance. We use Infloww today. It has no
> opening-message data, it calculates reply time in a way we can't see, and we are not sure its script numbers are
> right.

Infloww is the client's agency CRM (they wrote "infloow"). We do not know its formulas. It does know which chatter
sent each message, because chatters log in to it. We don't, yet (section 2, "Who sent a message").

## 2. What we can measure

Terms used below:

- **Inbound / outbound.** `fromUser.id` is not / is the account itself (the split `services/upstream/events.py` uses).
- **Mass** = outbound whose `queueId` matches a broadcast with `sentCount > 1` in `mass`. `isFromQueue` alone is not
  trusted: a scheduled 1:1 through `/messages/queue` (`of_client.schedule_message`) probably sets it too. Verify one.
- **Automated** = outbound that matches the OF welcome message (`tmpl`, text or media) or a text on the client's
  automation list (Infloww automations, bots). These arrive as ordinary DMs (`isFromQueue: false`), so without this
  rule they count as instant replies and openers.
- **DM** = outbound that is neither mass nor automated. **Fan turn** = inbound messages in one chat from the first
  inbound after a DM up to the next DM; mass and automated messages do not end it. Messages are ordered by
  `(createdAt, id)`. **Reply** = the DM that ends a turn.
- Times are the message `createdAt`, reported in a configured timezone. Windows are config (4.5).

Sources ("passthrough" = reachable now through `/v1/{account}/_of/...`, merged in b456cdf; named routes per
[plan-v5](docs/spec/plan-v5.md) and [the inventory](docs/spec/plan-v5-inventory.md)):

| Key | OF route | Served today? |
|---|---|---|
| `msgs` | `GET /v1/{account}/chats`, `GET /v1/{account}/chats/{chatId}/messages` (raw OF message objects) | yes |
| `mass` | `users/me/stats/messages/group` (per broadcast: queue `id`, `sentCount`, `viewedCount`) | passthrough; v5 P2 |
| `tmpl` | `messages/templates?template=reply_on_subscribe` (the OF welcome message) | passthrough |
| `tx` | `payouts/transactions` (type, amounts, currency, description; fan id unverified) | passthrough; v5 P4 |
| `earn` | `payouts/earning-statistics` (`of_client.earning_stats`), `statistics/overview` (OF's own totals) | yes (v5) |
| `bought` | `chats/{chat_id}/media?purchased=1&from_user=<account>` (PPVs the fan owns) | passthrough; v5 P2 |
| `subs` | `subscriptions/subscribers` (`type`, `min_spent`), `fans/{user_id}/subscriptions-history` | passthrough; v5 P3 |
| `send_log` | New gateway table: which key sent which message (4.3) | no |

| Metric | Definition | Source | Confidence / caveats |
|---|---|---|---|
| Reply time | Turn start to its reply. Median and p90 **among replies within `reply_cap`**, never the mean. Always shown with counts: replied in cap, late (replied after cap), breached (no reply, cap elapsed), pending (cap not elapsed at `as_of`) | `msgs`, `mass`, `tmpl` | High for timestamps. Medium until the automation rule is checked on real data |
| Reply SLA | Turns replied within `sla`, divided by turns whose cap has elapsed. Breached share is the old "unanswered rate" | same | Same |
| Substantive reply | Reply time where the reply has `min_reply_chars`+ (after tag strip) and is not on the filler list ("one sec babe"). Shown beside a reply-length distribution | same | Medium; the filler list is the client's |
| First reply time | Reply time for the first turn after `open_gap` of silence | same | Same as reply time |
| Per-message reply time | Each inbound message to the next DM. Only to compare with Infloww: a 5-message burst counts as 5 waits | `msgs` | High, but misleading |
| By hour / shift | Grouped by turn start hour or shift. Wall-clock is the default; staffed time (off-shift hours removed) is a separate metric, never mixed in | + shift schedule | Hour: high. Shift: needs the schedule |
| Opener | A DM after `open_gap` with no inbound and no DM (mass and welcome do not reset the gap), where the fan did not write first. Kind `first_ever` (chat walked to its start), `reactivation` (an earlier message is in coverage), `unknown` (the gap runs off our coverage). Chats whose gap holds only mass or welcome are reported apart | `msgs`, `mass`, `tmpl` | Verify: automation rule and chat coverage first |
| Opener reply rate | Openers with an inbound within `open_reply`; pending until the window elapses. Substantive variant too | `msgs` | Verify |
| Time to fan reply | Median from opener to the fan's first inbound | `msgs` | Verify |
| Opener conversion | Openers followed by a `tx` from that fan within `convert`, and its revenue | `msgs` + `tx` | Medium; needs fan id on `tx` |
| Script | A DM whose text hash (4.4) appears 5+ times in 3+ chats in 30 days, or a registered script. Offer identity (`media_key` + price) is a separate key | `msgs` | Medium; verbatim sends high |
| Script sends | Count and distinct chats, per account and hour | `msgs` | High per account; per chatter only from `send_log` |
| Script reply rate | Per outbound sequence (consecutive DMs with no inbound between): replied if an inbound arrives within `open_reply` after the sequence's last DM, so multipart scripts are not penalised. Substantive variant too | `msgs` | Medium; descriptive, not causal |
| Script revenue | A `tx` linked to a PPV message credits that message's script first and is excluded from last touch. Other `tx` go to the latest script send in that chat within `script_credit`. Opener and script credits overlap: never add them | `msgs` + `tx` | Medium; a model with its window shown, not cause |
| PPV unlock rate | PPV = DM with `price > 0`. Unlocked = a message-type `tx` linked to it: same fan, same price, newest such PPV sent before the `tx`. `bought` only confirms the fan owns the media (its `createdAt` is send time, not buy time). By price band and PPV age, since PPVs sell late. Also revenue per PPV sent by price band, and the same `media_key` sent at different prices | `msgs` + `tx` + `bought` | Medium. On a priced message `isOpened` means bought, not viewed (docs/chat-mining-findings.md §8: 93/93 opened rows priced outbound, payments match 86/86) |
| PPV follow-up | Unbought PPVs with no DM in that chat within `followup` of the send | `msgs` + `tx` | Deferred with PPV unlock rate |
| Tips | `tx` of type tip is the ledger. Inbound `isTip` messages only place a tip in the chat; never summed with `tx` | `tx`, `msgs` | High for amounts |
| Revenue per chat / fan | Sum of `tx` per fan, gross and net, currency as given; refunds kept as their own rows (verify how OF lists them) | `tx` | High if `tx` has a fan id; else parsed from `description`, Medium |
| Totals vs OF | Per day, our `tx` sums beside OF's `statistics/overview` and `payouts/earning-statistics`; a gap means missing `tx` | `tx` + `earn` | High; the trust anchor, shown beside every money number |
| Chargeback ratio | Account-level ratio as OF reports it; no fan or chatter link | `chargebacks/ratio` (shipped) | Medium |
| Revenue per chatter | Revenue credited to `send_log` sends; the rest is "unknown" | `tx` + `send_log` | Low; coverage shown |
| Mass vs 1:1 | Messages, PPVs and unlock revenue split by the mass rule; per broadcast sent and viewed counts | `msgs`, `mass` | Medium until the 1:1 queue case is verified |
| Retention / churn | Renewals divided by subscriptions expiring in the period; churned spend from our own `tx` sums (labelled with backfill depth) or `subs` `min_spent` | `subs`, `tx` | Medium |
| Big-spender coverage | Reply time and breached share for the top 10% of fans by our `tx` sums (labelled with depth) or `subs` `min_spent`, vs the rest | `msgs` + `tx` | Medium |
| Waiting now | Worklist via `.../samples`: open fan turns at `as_of`, sorted by age, then fan spend. "Now" is the last re-read, not live | `msgs` + `tx` | High for age; spend as big-spender coverage |
| Chatter activity | DMs per hour, active chats per hour, backlog (open turns) at any moment and at shift end | `msgs` | Per account; per chatter only from `send_log` |
| Handover quality | Open fan turns inherited at each shift change, their age, and the incoming shift's first-reply time on them | `msgs` + shift schedule | Medium; needs the schedule (question 2) |
| Message mix | Share of DMs with media, PPVs per conversation, time to first PPV, average PPV price | `msgs` | High |

What we cannot attribute today:

- **Who sent a message.** OF records the account, not the chatter. Sends through the gateway can be attributed with
  `send_log` (key → chatter). Sends from OF web or Infloww cannot; they go to an "unknown" bucket, and every
  per-chatter number shows attribution coverage (attributed DMs / all DMs) beside it. Until then the slice is per
  account, per hour and per shift, not per chatter.
- **When a fan read a message.** `isOpened` is a flag with no time.
- **Unsent or deleted messages.** They vanish from history. The daily re-read (4.2) only catches recent ones;
  `messages.deleted` is not emitted.
- **Why a purchase happened.** Any script or opener credit is a model with a window, not a fact.

## 3. Where Infloww is likely wrong or unverifiable

We can't see Infloww's formulas, so these are the usual traps, each with the rule we use instead.

| Likely trap | Effect | Ours |
|---|---|---|
| Mean reply time | One overnight gap outweighs a hundred fast replies | Median and p90, with breached, late and pending counts |
| Silent cap on long waits | Slow replies vanish from the average | Median labelled "among replies within 12 h"; late and breached counted beside it |
| Per message, not per fan turn | A fan who sends 5 short messages counts 5 times | Once per fan turn, from its first message |
| Mass messages count as replies | A broadcast "replies" to every waiting fan | Only DMs reply; mass does not end a turn |
| Automated sends count | Welcome messages, automations and bots look like instant replies and openers | Excluded by the welcome template and the client's automation list, counted apart |
| Any DM stops the clock | "one sec babe" counts as a reply | Substantive-reply variant and reply-length distribution |
| Off-shift hours included | Reply time grows with hours nobody worked | Wall-clock and staffed time are separate metrics |
| Exact-text script matching | Personalised scripts stop matching | Published normaliser; each script lists its exact variants |
| Loose matching | Different offers merge into one "script" | Numbers, emoji and prices kept; variants visible and splittable by tag |
| Revenue credited to every script in a window | Script revenue exceeds what the account earned | One credit per purchase; totals never exceed revenue |
| Day boundaries in an unstated timezone | Daily numbers don't match OF's | Timezone is config and echoed in every response |
| Where Infloww is ahead | It knows which chatter sent each message | We know it only for gateway sends (`send_log`) or via an Infloww export join (question 1) |

How "verifiably better" works:

- **Formulas are data.** `GET /v1/stats/metrics` returns each metric's formula in words, its windows, and a
  formula version and normaliser version.
- **Reproducible.** Every result carries `as_of`, the config snapshot version, coverage (chats walked, oldest message
  reached, share of chats walked to their start, backfill depth for money) and exclusions with counts (automated,
  mass, too short). Same data and versions give the same number.
- **Every number drills down.** `.../samples` returns the rows behind it: chat id, message ids, timestamps and the
  value computed for each. The client opens that chat in OF and checks.
- **Checked before we claim anything** (section 6, step 0). A difference from Infloww we can't explain is listed as
  unresolved, not as proof Infloww is wrong.

## 4. Design sketch

### 4.1 Where it lives and who sees it

Gateway-side Postgres, a new `apps/api/src/modules/analytics`. This answers where the aggregate store lives
([handoff §6.3](docs/spec/handoff-of-serving.md#6-open-decisions-resolve-before-coding)).

Tenancy: each account belongs to one workspace, `account_workspace(account_id pk, team_id)`, filled from the account
allowlists (`allowedAccountIds`) on that workspace's keys. An account named by two workspaces' keys is rejected as a
config error. A stats request sees only its workspace's accounts, narrowed further by the key's own allowlist; a key
with no allowlist sees its workspace's accounts, not every account. `script`, `stats_config`, `send_log` and every
aggregate, sample and CSV export are scoped this way. This meets the Phase 3 acceptance (a second workspace cannot
see the first's data). Events and REST keep the operator-wide model in [realtime.md](docs/realtime.md#tenancy).

### 4.2 Ingestion: backfill only

- **Messages.** Per account, walk `GET chats` (most recent first) until chats fall before the range. For each chat,
  page messages newest first with `id=<oldest id seen>` until `hasMore` is false or a page adds no new id. Do not
  follow `x-next-page`: [plan-v5 §2.2](docs/spec/plan-v5.md) ends paging on a short page, and OF returns short
  message pages before the end (`of_client.get_messages`). Rate-capped as in 6.1. Each chat records the oldest
  message reached and whether the walk hit the start (coverage; openers use it).
- **Mass history** is read in one-day windows: the group endpoint ignores `offset` and always reports `hasMore`
  (`of_client.py` no-progress guard). **Transactions** are read for the range; the **welcome template** once per run.
- **Refresh.** A daily re-read of the last `reread_days` for chats with new messages. A chat whose only new messages
  are mass is skipped, so one broadcast does not trigger a re-read of every recipient. Unsends older than the window
  are missed and shown in coverage. Upsert key `(account_id, message_id)`, so re-reads never double count.
- **No live ingestion.** [`messages.received` and `messages.sent`](docs/webhooks.md#event-types) are emitted, but
  delivery is at-most-once and live frames carry a reduced payload (`fromUser` is only `{id}`, no `toUser`; see the
  webhooks.md payload notes). So an event is only a re-read hint: it marks its chat for the next re-read.

### 4.3 Tables

- `message_fact`: `(account_id, message_id)` pk, `chat_id`, `direction`, `created_at`, `is_mass`, `queue_id`,
  `is_automated` and its reason, `price_cents`, `is_tip`, `media_count`, `media_key` (sorted media ids), `text_hash`
  (outbound), `raw` (jsonb: OF's message object as fetched, fan text included, scoped like everything else),
  `fetched_at`. Derived columns are rebuilt from `raw` when a definition changes, without a re-scrape.
- `chat_coverage`: `(account_id, chat_id)` pk, `oldest_message_id`, `oldest_at`, `reached_start`, `walked_at`.
- `purchase_fact`: `(account_id, tx_id)` pk, one row per OF transaction, the only source of money and purchase time.
  `fan_id`, `fan_id_source` (`field`, `description` or null), `kind`, `gross_cents`, `net_cents`, `currency`,
  `created_at`, `message_id` (the PPV linked by the unlock rule, else null), `raw` (jsonb).
- `send_log`: `(account_id, message_id)` pk, `chat_id`, `api_key_id`, `created_at`. Written by the proxy on a 2xx
  `POST /v1/{account}/chats/{chatId}/messages`, taking the message id from the response. The request log can't do
  this: it keeps response bodies only on errors by default (`LOG_BODIES`, `logs/capture.ts`). Chatter = the key's
  name, so each chatter needs their own key.
- `account_workspace`: as in 4.1.
- `script`: `(team_id, hash)` pk, `origin` (`auto`; `registered` once registration is built), `normaliser_version`.
  Exact variants, their counts and the first and last send are read from `message_fact`. `label` and `tag` come with
  registration (`POST`/`PATCH /v1/stats/scripts`, not built).
- `stats_config`: per workspace, the windows, timezone, automation list and filler list. Every change is a new
  version; results cite it.
- `fan_turns`, `chat_opens`, `script_sends`: SQL views over `message_fact`. Materialise one only when a query is slow.

### 4.4 Script identity

Recommendation: **normalised text hash, plus an optional tag.**

- Normaliser (conservative, versioned): unescape HTML and strip tags (OF text is HTML: `<p>`, `<br />`, `&amp;`),
  Unicode NFKC, lowercase, collapse whitespace, and replace the fan's name, username and custom name (the account's
  nickname for the fan) with `<name>`. Numbers, emoji, prices and punctuation stay, so different offers stay apart.
  Hash with SHA-256, keep 16 hex characters.
- A script needs 4+ tokens or 20+ characters after normalising, so "hey" and empty captions don't collide.
- Copy identity (text hash) and offer identity (`media_key` + price) are separate; a PPV script reports both.
- Registered library: the client pastes its scripts with names, using `{name}` where the fan's name goes; we hash
  them the same way and they win over auto-detect.
- Fuzzy matching only if we measure the need: the share of DMs of 40+ characters that nearly match a script but hash
  differently.

### 4.5 Windows are config

| Key | Default | Used by |
|---|---|---|
| `reply_cap` | 12 h | reply time, SLA, breached |
| `sla` | 15 min | reply SLA |
| `min_reply_chars` | 15 | substantive reply |
| `open_gap` | 7 d | opener detection, first reply time |
| `open_reply` | 24 h | opener and script reply rate |
| `convert` | 72 h | opener conversion |
| `script_credit` | 24 h | script revenue |
| `followup` | 24 h | PPV follow-up |
| `reread_days` | 7 | refresh |
| `timezone` | UTC | hour and day buckets |

Changing a value makes a new config version and recomputes from `message_fact`; nothing is baked in at ingest.

### 4.6 API

| Route | What it does |
|---|---|
| `GET /v1/stats/metrics` | Catalogue: id, formula in words, windows, formula and normaliser versions |
| `GET /v1/stats/metrics/:id` | Series. Query: `accountId`, `from`, `to`, `groupBy` (`day`, `hour`, `account`, `script`, `shift`, `segment`), `tz`, `format` (`json` or `csv`) |
| `GET /v1/stats/metrics/:id/samples` | The rows behind a number, same query plus `limit` and `cursor` |
| `GET /v1/stats/scripts` | Scripts with sends, reply rate and their exact variants |
| `POST /v1/stats/scripts`, `PATCH /v1/stats/scripts/:hash` | Register scripts; set label or tag (`write` key) |
| `GET`, `PUT /v1/stats/config` | Windows, timezone and lists (`PUT` needs `write`) |

Every response carries `as_of`, versions, coverage and exclusions (section 3), scoped as in 4.1. `GET /v1/stats` stays.
`groupBy=segment` splits fans into new/active/dormant/expired, free/paid and auto-renew on/off, from `fans/active`,
`fans/expired`, `fans/latest` (OF path still on the owner live-check list) and `fromUser.subscribedByAutoprolong` /
`subscribedByExpireDate` / `subscribedOn` in `message_fact.raw` (REST reads only; live frames lack them).

## 5. Open questions for the client

1. **Chatter identity.** Which of these can you do? (a) Chatters send through our gateway, one key each (`send_log`).
   (b) Give us an Infloww export that names the chatter per message; we join it by message id, or by time and text.
   (c) Only a shift schedule, so numbers are per shift, not per chatter.
2. **Shifts.** Schedule per account: start, end, timezone, handovers.
3. **What is a script?** Do you have a written library you can export? Does a lightly edited script still count?
4. **Attribution window.** How long after a script or opener should a purchase count: 24 h, 72 h? Is last touch fine?
5. **Timezone.** Agency time or each model's own?
6. **Openers and automations.** What silence makes a conversation "new" (7 days?). Which automations send on your
   accounts (Infloww automations, bots, OF welcome)? Send us their texts.
7. **Scope and volume.** Which accounts, how much history, and roughly how many chats are active per account per
   week? This sizes the backfill (6.1).
8. **Chatter pay.** What is the pay formula, and which number settles a dispute?
9. **Whales.** How do you define a whale or VIP? Is a next-day report enough, or do you need a live ping?
10. **Infloww today.** Which reports do you open daily, and which decision does each drive?
11. **Follow-ups.** What is your playbook for unbought PPVs and for expired fans?
12. **Chatter rules.** Banned words, off-platform contact, duplicate PPVs, price floors: which apply, and how are they
    checked today?
13. **Free vs paid pages.** Which accounts are free, which paid?
14. **Acquisition.** Are tracking links and acquisition in scope?

## 6. First slice: account and shift performance

Precondition: an Infloww export for one account and one past week, plus Infloww's definitions of reply time and
scripts (their docs or the client's understanding). Without it step 0 can't run, so we don't start.

0. **Backfill only, one account, one past week, to CSV.** Messages, mass history, welcome template and that week's
   transactions, rate-capped (6.1). No live ingest, no money polling. Diff reply time and per-chat counts against the
   Infloww export; every difference is explained or listed as unresolved.
1. **Reply time and Reply SLA** (with breached, late and pending counts), by account, hour and shift, with samples.
2. **Openers**, only after step 0 shows by hand-checked samples that the automation rule and chat coverage hold.
3. **Script candidates**: auto-detected hashes with exact variants, sends and reply rate. No money.

Deferred: PPV unlock rate, opener conversion and script revenue (they need fan id on `tx` confirmed), rankings,
per-chatter numbers (from when chatters send through the gateway, or an Infloww join), retention, fan LTV and a whale
list, expired-fan win-back, content supply (which media sells), QA scans for chatter rules (question 12), and the
stats page builder (handoff Phase 3).

Out of scope: live alerts (whale online), and Sheets beyond CSV (no `IMPORTDATA`: the key would be in the URL).

### 6.1 Volume and request budget

Requests for one account-week ≈ chat-list pages + for each chat active that week (pages holding that week's messages
+ 1 boundary page) + 7 mass-history windows + transaction pages. OF message pages hold about 30 to 70 messages
(`of_client.get_messages`). With made-up numbers: 1,000 active chats × 2 pages ≈ 2,000 requests, about 3.5 hours at
600 an hour. Openers cost more: telling `first_ever` from `reactivation` walks a chat further back, to its start.

Controls: per-account cap per hour (default 600, a guess), 300 ms between pages (as `of_client.iter_messages`), one
account at a time, back off on 429, and a stop switch checked before every page.

Unknown: how many accounts; active chats and messages per account-week; OF's real rate limit (none documented; the
300 ms delay comes from the reference fetcher); how far back transactions go; whether heavy history reads put the OF
account at risk. No data on any of these, hence the cap and the stop switch.

Acceptance, for one account and one past week:

- each slice metric has a value and 20 samples the client confirms by hand in OF;
- completeness: per-chat message counts match a fresh re-read, and the week's `tx` total matches `earn` for the same
  days (Totals vs OF). On 2026-10-06 the upstream's `/payouts/earning-statistics` and `/payouts/transactions?startDate=`
  ignored the date range and returned all-time figures, so the backfill filters by date itself;
- the Infloww diff has every difference explained or listed as unresolved;
- a key from a second workspace sees none of it.
