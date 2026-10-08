# Handoff: mine 90 days of chats for stats ideas

Written 2026-10-08 (store state read 2026-10-08 19:20 to 19:35 UTC). Background: [docs/analytics.md](docs/analytics.md),
[docs/analytics-backfill.md](docs/analytics-backfill.md), [spec §2 and §6](docs/spec/future-client-story-ask.md),
[Infloww definitions](docs/spec/infloww-definitions.md).

## 1. Goal

Store the last 90 days of DMs for the live account(s) and export them. Then write a list of stats ideas that the
stored data really supports, compared with what AI chatter tools show. The output is a ranked list of ideas plus the
numbers behind each one.

## 2. Runbook: get 90 days stored and exported

What was in the store on 2026-10-08 (from psql). Both accounts are in workspace `jaka-basej-ehpyuz`, team
`bc407cc9-d7cd-499a-87fe-58a04e67f71a`:

| Account | OF session | `message_fact` rows | Range stored | Chats (`chat_coverage`) | `purchase_fact` |
|---|---|---|---|---|---|
| 337749380 = @isaraee (Isabelle Rae) | working | 9,500 (1,932 fan, 5,564 DM, 1,957 mass, 47 automated) | 2026-09-09 .. 2026-10-08 | 656 (walked 18:16 to 19:18 UTC), 1 walked to its start | **0 rows** |
| 91610731 = Main (@jakabasej) | **dead** (2026-10-08) | 11,588 (10,038 of them in 2026-09) | 2025-01-25 .. 2026-10-05 | 87, 0 walked to start | **0 rows** |

So 337749380 is the account to backfill. Main can only be mined from what is already stored, until someone
re-connects it on Accounts.

**0. Pre-flight**

- **Services.** `curl localhost:4000/healthz` must return `{"ok":true}`. The upstream listens on :3001, Postgres on
  :5434 and the dashboard on :5174. The DSN in `.env.example`, `postgres://gateway:gateway@localhost:5434/gateway`,
  worked on 2026-10-08.
- **Root `.env`.** The CLIs read the repo root `.env` (`--env-file-if-exists=../../.env` in `apps/api/package.json`)
  and need `DATABASE_URL`, `UPSTREAM_URL` and `UPSTREAM_TOKEN`. Check with
  `grep -cE '^(DATABASE_URL|UPSTREAM_URL|UPSTREAM_TOKEN)=' .env`, which must print `3`.
- **API key.** On 2026-10-08 the workspace had **no API keys**. Create one on Dashboard → API keys, allowlisting
  `337749380`. The CLI's claim (`claimAccount`, `apps/api/src/modules/analytics/workspace.ts`) needs a live key of
  any scope that lists the account; `write` is needed only for `POST /v1/stats/backfill`. Keys get 120 requests a
  minute (`KEY_RATE_LIMIT_PER_MIN`, `apps/api/src/env.ts`). Then `export GW=http://localhost:4000 KEY=<key>`.
- **Workspace.** The CLIs need `--team bc407cc9-d7cd-499a-87fe-58a04e67f71a` unless `account_workspace` already has
  the account (`accountTeam`, `apps/api/src/cli/analytics-export.ts`). On 2026-10-08 it had both accounts.
- **Session.** `curl -fsS -H "Authorization: Bearer $KEY" $GW/v1/accounts | jq` must show 337749380 with
  `"status": "active"`. If it shows `session_expired`, re-connect the account on Accounts.

**1. Backfill 90 days.** Use the CLI. It runs in its own process, so a `tsx watch` restart of the dev API does not
kill it. A dashboard or route run lives in the API's memory and dies when the API restarts.

```sh
mkdir -p ~/of-capture/chat-mining/337749380-90d
pnpm --filter @gateway/api analytics:backfill --account 337749380 \
  --from 2026-07-11 --to 2026-10-09 --out ~/of-capture/chat-mining/337749380-90d 2>&1 | tee ~/of-capture/chat-mining/337749380-90d/backfill.log
```

`--from` is inclusive and `--to` exclusive (UTC midnight): the 90 days 2026-07-11..2026-10-08; move both dates if
you run later. A finished run prints `requests: N; stopped: no` and `chats N, messages N, broadcasts N,
transactions N, ...`; keep that log. It writes four CSVs, none with message text.

Use the route only if the API process is stable, meaning not `pnpm dev` while someone edits `apps/api`:

```sh
curl -fsS -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"accountId":337749380,"days":90}' $GW/v1/stats/backfill            # 202 {runId}; days 1..366
while sleep 30; do curl -fsS -H "Authorization: Bearer $KEY" "$GW/v1/stats/backfill?accountId=337749380" \
  | jq -c '{status,requests,chats,messages,retries,error,errorCode}'; done   # stop at done or error
```

If the poll shows `idle` partway through, the API restarted and the run is gone. Start again: rows upsert, but there
is no resume.

**Budget.** Chats drive the cost, not messages. Reference ([TESTING.md §6](TESTING.md), CLI, 2026-09-06..10-06 on
Main): 259 requests in 12 min for 87 chats and 9,150 messages. A run requests chat-list pages (about 10 chats each),
1 or 2 message pages per active chat (100 messages a page, `PAGE` in `apps/api/src/modules/analytics/backfill.ts`,
plus a boundary page), one mass-history window per day from the day before `--from` (91 or more), and the
transaction pages. The unknown is N, the chats active in the 90 days (656 in 30 days is only a lower bound). At
N = 1,000: about 100 + 1,500 + 91 ≈ 1,700 requests, close to 3 h at the default `ANALYTICS_REQUESTS_PER_HOUR=600`.

**2. Check the store.** Open `psql postgres://gateway:gateway@localhost:5434/gateway` and create view `m`. It is
used here and in §3.

```sql
create temp view m as select *, (direction='outbound' and not is_mass and not is_automated) is_dm from message_fact
where team_id='bc407cc9-d7cd-499a-87fe-58a04e67f71a' and account_id=337749380 and created_at >= '2026-07-11T00:00Z' and created_at < '2026-10-09T00:00Z';
select date_trunc('week', created_at)::date wk, direction, count(*) from m group by 1,2 order by 1,2;
select count(*), count(*) filter (where reached_start), min(oldest_at) from chat_coverage where team_id='bc407cc9-d7cd-499a-87fe-58a04e67f71a' and account_id=337749380;
```

Note the `unmatched queue ids` and `incomplete chats` counts from the backfill log.

**3. Export transcripts.**

`GET /v1/stats/fans` and `GET /v1/stats/messages` were committed in 801f1a3 (a fix lands on top; contract in
`apps/api/src/contracts.ts`, `statsFans` and `statsMessages`). `from`/`to` are days in the stats timezone (UTC by
default), `to` inclusive; always pass both. `fans` returns `total` and `items[]` (`chatId`, `fanUsername`,
`fanMessages`, `dmMessages`, `massMessages`, `automatedMessages`, `firstAt`, `lastAt`, `lastFanAt`), newest
`lastFanAt` first; `total` above the item count means `limit` cut it. The messages CSV is streamed and holds the
whole range; JSON stops at `limit` and sets `truncated`.

Save each file only after its first line looks right. Otherwise a 401 or 429 body would land as a `.csv`:

```sh
OUT=~/of-capture/chat-mining/337749380-90d; Q="accountId=337749380&from=2026-07-11&to=2026-10-08"
get() { curl -fsS -H "Authorization: Bearer $KEY" "$GW$1" -o "$2.part" && head -1 "$2.part" | grep -q "$3" && mv "$2.part" "$2" || echo "FAILED $2"; }
get "/v1/stats/fans?$Q&limit=1000" $OUT/fans.json '"total"'
get "/v1/stats/messages?$Q&direction=all&format=csv" $OUT/messages-all.csv 'account_id,chat_id'
get "/v1/stats/messages?$Q&direction=in&format=csv"  $OUT/fan-replies.csv  'account_id,chat_id'   # fans' messages only
```

`messages-all.csv` already holds every chat. To get one file per fan, split it locally. Column 2 is `chat_id`, and
`text` has its line breaks collapsed, so one row is one line:
`mkdir -p $OUT/chats && awk -F, -v d=$OUT/chats 'NR==1{h=$0;next} {f=d"/"$2".csv"; if(!(f in s)){s[f]; print h > f} print >> f; close(f)}' $OUT/messages-all.csv`

For the raw HTML and the unlock hint, or if the routes are missing, export from the view in the same psql session
(tested 2026-10-08):

```sql
\copy (select m.chat_id, c.fan_username, m.created_at, m.direction, m.is_mass, m.is_automated, m.price_cents, m.raw->>'canPurchaseReason' unlock_hint, m.raw->>'text' text_html from m left join chat_coverage c using (team_id, account_id, chat_id) order by m.chat_id, m.created_at, m.message_id) to '~/of-capture/chat-mining/337749380-90d/messages-raw.csv' csv header
```

Keep every export out of the repo, because it holds fan ids and fan text.

**Money is unconfirmed.** `purchase_fact` has 0 rows for both accounts. Yet in 30 days @isaraee sent 111 PPVs
(19 marked `opened`, $567.99 list price) and got 2 fan tips. Revenue ideas are blocked until these three checks are
done:

- **(a) Did a run reach transactions?** `backfill.ts` reads them last (`readTransactions`, after every chat walk).
  The stored 337749380 rows came from a run whose last chat walk was at 19:18 UTC. Nothing was written after that,
  and its final status is unknown: a route run dies on an API restart or a `session_expired`. The CLI's
  `transactions N` line settles it.
- **(b) Does the named route answer?**
  `curl -fsS -H "Authorization: Bearer $KEY" "$GW/v1/337749380/payouts/transactions?limit=10&startDate=2026-07-11%2000:00:00" | jq`.
  The backfill calls this route, not the `_of` passthrough. Spec §6.1 notes that the upstream ignored `startDate`
  on 2026-10-06.
- **(c) Short pages (a hypothesis).** `readTransactions` moves `offset += 100` however many rows a page held. If OF
  answers with short pages, as it does for chats, rows are skipped. This is untested:
  `apps/api/test/fake-upstream.ts` always returns full transaction pages. Compare (b) with `&offset=10`.

**Other gotchas**

- **Session expiry.** An OF 401 or "Wrong user" stops the run (`errorCode: session_expired`); Main died this way on
  2026-10-08. **In-memory runs:** the API's one-run-per-account guard does not see CLI runs, so never start a route
  run for an account while its CLI run is going.
- **Rate limits.** OF documents none; the 600/h cap is a guess. A 429 backs off (8 retries, then the run fails), a
  502/503/504 is retried 3 times, and each run counts its cap from zero, so leave an hour between runs.
- **Mass makes every chat active.** In 30 days 656 chats got mass messages, but only 212 fans wrote.
- **PPV unlock hint is unverified.** On outbound PPVs, `raw->>'canPurchaseReason'='opened'` (with `isOpened=true`)
  is the only unlock signal stored. The spec says `isOpened` means viewed, not bought. Check 5 cases in OF.
- **No fan profile in the store.** `raw->'fromUser'` is only `{id,_view}` on 1,931 of 1,932 fan rows. Subscribe
  date, auto-renew and `lastSeen` are not stored.
- **Coverage.** Only 1 of 656 chats was walked to its start, so most openers have kind `unknown`.
- **Deletes are hard.** A live `messages.deleted` deletes the `message_fact` row (`apps/api/src/modules/analytics/live.ts`),
  so a fan's unsent message disappears from the export.

## 3. What to compute first

Use view `m` from §2 step 2. Every query below was tested on 2026-10-08 against the stored 30 days. Route ranges
`from=2026-07-11&to=2026-10-08` match the view's bounds.

1. **Per-fan reply rate**: the share of fans reached who ever wrote back (30 days: 212 of 656). It sizes the
   chattable base against the broadcast-only base.
   `select count(*), count(*) filter (where fan>0) from (select chat_id, count(*) filter (where direction='inbound') fan from m group by 1) f;`
2. **Fan response latency**: time from our DM to the fan's next message (30 days: median 93 s, p90 10 h, n=1,426).
   It shows when fans are live, which is the basis for upsell timing.
   `select percentile_cont(array[.5,.9]) within group (order by extract(epoch from created_at-p)) from (select *, lag(created_at) over w p, lag(is_dm) over w pdm from m window w as (partition by chat_id order by created_at, message_id)) x where direction='inbound' and pdm;`
3. **Our reply time and SLA**: already built.
   `GET /v1/stats/metrics/reply_time?accountId=337749380&from=2026-07-11&to=2026-10-08&groupBy=day`, and the same for
   `reply_sla` and `reply_time_p90`. Every competitor leads with this number.
4. **PPV unlock conversion**: PPVs sent and marked opened, with the list price of the opened ones, mass against DM.
   This is the "unlock rate" the competitors show. It is unverified until the hint is checked (§2).
   `select is_mass, count(*), count(*) filter (where raw->>'canPurchaseReason'='opened'), sum(price_cents) filter (where raw->>'canPurchaseReason'='opened')/100.0 from m where direction='outbound' and price_cents>0 group by 1;`
5. **Revenue per fan**: spend per fan from transactions. It is the base for LTV, whale lists and big-spender
   coverage. Blocked until checks (a) to (c) are done.
   `select fan_id, kind, count(*), sum(gross_cents)/100.0 from purchase_fact where team_id='bc407cc9-d7cd-499a-87fe-58a04e67f71a' and account_id=337749380 and created_at >= '2026-07-11T00:00Z' and created_at < '2026-10-09T00:00Z' group by 1,2 order by 4 desc;`
6. **Conversation length**: message count per session, where a session ends after a 6 h gap and mass is excluded.
   It shows whether chats die after 1 or 2 messages or run long.
   `select width_bucket(n,1,101,10), count(*) from (select chat_id, s, count(*) n from (select chat_id, sum(case when p is null or created_at-p>interval '6 hours' then 1 else 0 end) over (partition by chat_id order by created_at, message_id) s from (select chat_id, created_at, message_id, lag(created_at) over (partition by chat_id order by created_at, message_id) p from m where not is_mass) a) b group by 1,2) c group by 1 order by 1;`
7. **Best hours**: fan messages, DMs, PPVs and opened PPVs by local hour. Use it to staff shifts and time PPVs
   (timezone: §6). Also `GET /v1/stats/metrics/reply_time?...&groupBy=hour`.
   `select extract(hour from created_at at time zone 'Europe/Ljubljana') h, count(*) filter (where direction='inbound') fan, count(*) filter (where is_dm) dm, count(*) filter (where price_cents>0 and direction='outbound') ppv, count(*) filter (where raw->>'canPurchaseReason'='opened') opened from m group by 1 order by 1;`
8. **Drop-off points**: in chats silent for 7 or more days before the window ends, the last non-mass message, by
   sender and type. It shows where conversations die.
   `select direction, price_cents>0 ppv, raw->>'canPurchaseReason', count(*) from (select distinct on (chat_id) * from m where not is_mass and not is_automated order by chat_id, created_at desc, message_id desc) l where created_at < '2026-10-02T00:00Z' group by 1,2,3 order by 4 desc;`
9. **Reactivation**: fans who wrote again after 7 or more days of silence, per week. Pair it with opener kind
   `reactivation` from `GET /v1/stats/metrics/openers?accountId=337749380&from=2026-07-11&to=2026-10-08`. This is
   the win-back number competitors sell.
   `select date_trunc('week', created_at)::date, count(*) from (select created_at, created_at-lag(created_at) over (partition by chat_id order by created_at, message_id) g from m where direction='inbound') x where g >= interval '7 days' group by 1 order by 1;`
10. **Scripts**: already built. `GET /v1/stats/scripts?accountId=337749380&from=2026-07-11&to=2026-10-08` gives the
    reply rate per repeated text, the closest thing we have to "what the AI should say".

For Main, recreate `m` with `account_id=91610731`.

## 4. Competitor findings

**"ai chat agenie" is not identified.** Eight searches on 2026-10-08 found no product by that name ("Agenie",
"Chat Genie", "ChatGenie", "AI Chat Genie", "Genie" with OnlyFans/chatter/CRM, and "AI chat agent" OnlyFans). It is
also not in the [ofm-tools AI chat directory](https://ofm-tools.com/ai-chat-onlyfans/). There are two readings: (a) **GenieHelper**¹, the only
name match, at low confidence; (b) a typo for "AI chat agent", which points to Supercreator's Izzy or Substy. The table covers both, with Infloww as the baseline. "(claim)" marks marketing copy, "(inferred)" marks my
inference, and "(vendor blog)" marks a vendor's own blog.

| Tool | Per-fan data kept | Metrics shown | Ingestion | How the AI uses history | Source |
|---|---|---|---|---|---|
| **Supercreator** (Izzy AI) | Purchases (what, how much, when), LTV, spend tier, lists, active vs "gone quiet", traffic source, notes and tags (preferred name, likes, refusals), which chatter closed each sale | Per chatter: private sales, $/hour, chat conversion, tips, messages sent, hours online, response time, open chats, PPVs sent, sales per shift. Per content: sent, opened, purchased, revenue, average price, unlock rate. Account: revenue by source/fan/chatter/content, churn and renewal trends, whale segments | Desktop and mobile apps. History "is imported when you connect", depth not stated. "Never collects or stores your login credentials", so likely a session relay (inferred) | Learns each fan's "history, tone, and spending habits". Copies the creator's "slang, rhythm, humor" and emojis (persona from past outbound messages, inferred). Picks "PPV content, price, and caption at the perfect moment". Re-prices old vault content (claim) | [fan-crm](https://www.supercreator.app/onlyfans-crm/fan-crm), [chatter-management](https://www.supercreator.app/onlyfans-crm/chatter-management), [revenue-content-analytics](https://www.supercreator.app/onlyfans-crm/revenue-content-analytics), [ai-chatter](https://www.supercreator.app/ai-chatter) |
| **Infloww** (baseline, the client's CRM) | Total spend *since the creator was added*, purchase rate (PPVs bought ÷ received), last and highest spend, PPV/tip totals and averages, subscription status, price, duration, auto-renew. Nickname, birthday, source, location by hand. PPV timeline. Notes. Inbox tags: New (subscribed ≤7 d), 🔥 recent buyer, ❄️ no messages 72 h, ❌ expired, Off (renew off) | Per employee: sales, DM sales (no mass), DMs sent, DM PPVs, golden ratio (DM PPVs ÷ DMs), unlocks, unlock rate, fans chatted, Fan CVR, earnings per paying fan, response time (scheduled and clocked). Fan reports: spend ranking, retention, auto-renew rate, subs gained/lost. Sales credited by shift, sender or "converter" (last message before payment) | Desktop app that proxies the creator's OF session ([infloww-definitions §8](docs/spec/infloww-definitions.md)), so the full chat history shows in its inbox. Only its spend stats start when the creator is added; no stats backfill (inferred from the fan-insights page) | AI Copilot (beta) "learns from every interaction", "remembers past interactions", live suggestions. Scripts in storylines. Event automations (fan online, new sub, after purchase, expiring/expired, resub, birthday) | [fan insights](https://help.infloww.com/en/articles/418759-fan-insights-panel), [messages pro](https://help.infloww.com/en/articles/262067-getting-started-with-onlyfans-messages-pro), [employee reports](https://help.infloww.com/en/articles/262078-employee-reports), [fan reports](https://help.infloww.com/en/articles/276167-fan-reports), [infloww.com](https://infloww.com/) |
| **Substy** (best "AI chat agent" match) | "Profiles, lists and conversation context", fan history, PPV sales. Fans auto-classed as Spenders, VIPs, Newbies, Timewasters. Remembers "name, interests, spending history, emotional triggers" (vendor blog) | "Creator and employee statistics". Per chatter: revenue, response rate, average basket (vendor blog) | Not stated. Public API: creators, subscribers, tagged users, conversation webhooks | "Your tone & personality", script and non-script PPVs, auto-replies, objection handling, price negotiation, renewal follow-ups (claim, vendor blog) | [substy.ai](https://substy.ai/), [API docs](https://docs.substy.ai/reference), [blog](https://substy.ai/blog/best-onlyfans-crm-for-agencies-in-2026-the-complete-comparison-guide) |
| **GenieHelper**¹ (name match only) | Claims 71 fields: total spend, message count, response rate, PPV/tip/custom totals, time-of-day activity, content affinity, sentiment, lifecycle stage, notes, tags, `fan_memories` (pet names, job, city, hobbies, past conversation facts) | `fan_scores`: churn risk, predicted LTV, upsell readiness, loyalty (no formulas). Subscription event log incl. win_back_sent. Dynamic segments | Server-side Playwright with injected session cookies or stored credentials. Profile plus 20 recent posts every 6 h. DM ingestion not described | Local LLMs (Ollama). Per-fan memories injected when drafting. Per-fan persona plus the creator's voice. Retrieval: HyDE + RRF | [fan-crm](https://mintlify.wiki/kismetkanceled/geniehelper/platform/fan-crm), [onlyfans](https://mintlify.wiki/kismetkanceled/geniehelper/integrations/onlyfans), [overview](https://mintlify.wiki/kismetkanceled/geniehelper/platform/overview) |
| **FlirtFlow** | "Impeccable memory", learns from fan interactions (claim) | Not stated | Connect OnlyFans in their web app; mechanism not stated | Autonomous PPV and custom selling, "drip method" (claim) | [flirtflow.ai](https://www.flirtflow.ai/) |
| **FansMetric** (definitions only) | n/a | Chat earnings (tips + PPV), messages per hour, messages per fan, Chat AFV (revenue per chatting fan), earnings per hour and per message, fans per hour, unlock ratio, golden ratio (PPVs ÷ all messages) | n/a | n/a | [chatter analytics](https://intercom.help/fansmetric/en/articles/9207508-chatter-analytics) |

¹ GenieHelper's docs live on mintlify.wiki under `kismetkanceled/geniehelper`. That looks like an auto-generated wiki
of a GitHub repo, not a commercial product: no company site was found. Its fan fields are design claims, not a
shipped service.

Common pattern: every tool is built on **per-fan spend plus recency** (whale tier, gone quiet, recent buyer). Chatter
boards share a core: response time, golden ratio, unlock rate, $/hour or $/message. The AI pitch is always
**per-fan memory** from the chat, a **creator persona** from past outbound text, and **PPV choice, price and
timing**. No vendor states its history depth. Hypothesis, not checked: per-fan stats over up to 366 days of backfilled
history, with fan text kept, beat stats that start when the creator is connected.

## 5. Gap list (what they show that we don't, cheapest first)

Tier **A** needs only `message_fact` (SQL on view `m`, or a small route). **B** needs `purchase_fact` filled, after
checks (a) to (c) in §2. **C** needs a new data source.

| # | Gap | Shown by | What it takes on our data | Tier |
|---|---|---|---|---|
| 1 | Golden ratio (DM PPVs ÷ DMs) by day and hour | Infloww, FansMetric | `count(*) filter (where is_dm and price_cents>0)::numeric / nullif(count(*) filter (where is_dm), 0)` from `m` (tested) | A |
| 2 | Fans chatted, messages per fan, active chats per hour | Infloww, FansMetric, Supercreator | `count(distinct chat_id) filter (where is_dm)`, by hour | A |
| 3 | Recency tags: ❄️ no fan message in 72 h, "gone quiet", last active | Infloww, Supercreator | `lastFanAt` in `/v1/stats/fans` (within the range). "New" needs the subscribe date (tier C) | A |
| 4 | Each fan's active hours (when to message them) | Supercreator (inferred), GenieHelper | Fan messages per `chat_id` by local hour, top 3 hours | A |
| 5 | PPV timeline per fan: sent, prices offered, highest and lowest, status | Infloww | Outbound `price_cents>0` per chat. Status uses the unverified `opened` hint | A, then B |
| 6 | Content stats per media: times sent, opened, average price, re-sell candidates | Supercreator | Group by `media_key` (stored). Unlocks as in row 5 | A, then B |
| 7 | Creator persona corpus (few-shot examples of how the model writes) | Supercreator, Substy, Infloww Copilot | `/v1/stats/messages?direction=out` CSV, keeping rows with `is_mass=false` and `is_automated=false`. Without that filter, 2,004 of the 7,568 outbound rows in 30 days are mass or automated. Export only | A |
| 8 | Per-fan memory (name, city, job, kinks, refusals, pet names) | Supercreator, Substy, GenieHelper | An LLM pass over each fan's `direction=in` text. The data is there. Cost: LLM spend and the privacy decision (§6 question 8) | A + LLM |
| 9 | Spend per fan, LTV, last and highest spend, whale tier, Fan CVR, Chat AFV, $/message, DM sales without mass | All | Group `purchase_fact` by `fan_id`, joined to chats | B |
| 10 | Verified unlock rate and time from send to unlock | Infloww, Supercreator, FansMetric | Tx-to-PPV link rule (spec §2). `purchase_fact` has no `message_id` column yet | B |
| 11 | "Converter" credit (last message before payment) | Infloww | `purchase_fact` time plus the previous outbound in that chat | B |
| 12 | Subscription lifecycle: renewals, expiries, auto-renew, churn and win-back cohorts | Infloww, Supercreator, GenieHelper | `subscriptions/subscribers` / `fans/*` reads. `raw.fromUser` lacks these fields on 1,931 of 1,932 rows | C |
| 13 | Per-chatter $/hour and sales per shift | Infloww, Supercreator | `send_log` or the Infloww export join, plus shift schedules (spec §5 questions 1 and 2) | C |
| 14 | Churn-risk and predicted-LTV scores | GenieHelper, Supercreator (claims) | A model on top of 9 and 12. YAGNI until those exist | C |

## 6. Open questions for the owner

1. What is "ai chat agenie"? Send the URL or a screenshot. It is unidentified (§4); GenieHelper and Substy are guesses.
2. Should Main (91610731) be re-connected so it can join the 90-day mining, or is @isaraee enough?
3. Which timezone should "best hours" use: the agency's (e.g. Europe/Ljubljana) or the model's?
4. Is "opened" on a PPV enough to call it bought, or must it match a transaction?
5. What is the mining for: a dashboard for chatters, training data for an AI chatter, or a pitch? The answer changes
   which gaps matter.
6. A fan's unsend (`messages.deleted`) hard-deletes the `message_fact` row. Should it become a soft delete, so the
   export keeps what the fan wrote and marks it unsent?
7. Which automations or bots send on @isaraee? Their texts make `is_automated` accurate (`--automation <file>`).
8. May the full fan text leave the machine, for example to an LLM for tagging or summaries? Today it stays in
   Postgres and `~/of-capture`.
