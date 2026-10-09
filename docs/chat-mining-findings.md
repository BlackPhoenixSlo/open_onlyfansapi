# Chat-mining findings: @isaraee (337749380), 2026-07-11..2026-10-09

Written 2026-10-09 for [HANDOFF-chat-mining.md](../HANDOFF-chat-mining.md) as of c1225b3; "handoff §N" uses that
file's current numbering. Aggregates only: no fan ids, usernames, message text or single-fan facts, and every fan
group counted here has 5 or more fans.

- **report**: the kit's `report-2026-10-09-045156Z.md`, generated 2026-10-09 04:51:57 UTC by
  `~/of-capture/chat-mining/kit/run.sh 337749380 2026-07-11 2026-10-09`. The kit, its reports, the run's log and all
  exports live in `~/of-capture/chat-mining/337749380-90d/` and the kit folder, outside the repo.
- **SQL**: read-only queries run 2026-10-09 04:50–05:10 UTC, with the same bounds on `message_fact` and
  `purchase_fact`: `created_at >= '2026-07-11T00:00Z' and < '2026-10-10T00:00Z'`. Routes: `from=2026-07-11&to=2026-10-09`.
- **Money** is as of 2026-10-09 04:51 UTC. Settled = `raw->>'status'` `done`; booked = `done` plus `loading`; net =
  `net_cents`, OF's payout after its 20% fee (0.80 × gross on every row). No `undo` or `pending_return` rows exist.
  A bare $ figure is booked gross.

## 1. Build next

Ordered by cost, after the owner's answer that all data is stored first and stats come after (handoff §1):

1. No code: re-derive the 10-09 02:39 UTC bulk send (likely mass, now 321 DMs) with a backfill over 2026-10-09..10-10.
2. No code: re-read transactions before reporting money, because `loading` rows settle over time (this doc §3).
3. Done, no capture needed: live outbound rows are mass when `isFromQueue` is true (this doc §2, bug 2).
4. SQL only: the bulk-send label in view `m` (this doc §3, caveat 2), a prerequisite for every DM-based metric.
5. New table: store the mass-history rows each backfill already reads; mass performance cannot come from chats.
6. Then the stats of this doc §5, cost 0 first.

## 2. Bugs found

1. **`purchase_fact.kind` was NULL on every row. Fixed in 551e282; rows now filled.** Live `/payouts/transactions`
   rows carry no top-level `type`; the kind sits at `raw->'descriptionDetails'->>'type'`. All 173 rows now have a
   kind, and all 173 equal that field (SQL). Handoff §3 step 2 covers the re-read that refilled rows that the pre-fix
   runs had nulled.
2. **Resolved, see below: `live.ts` stored every live DM as mass.** `liveRow` in
   `apps/api/src/modules/analytics/live.ts` sets `isMass` to "outbound and `queueId` not null". Every stored message
   carries a queue id (17,669 of 17,669 DMs and 9,203 of 9,203 fan messages in the window), and all 59 stored
   `messages.received` payloads carry a numeric `queueId` with `isFromQueue` false. No `messages.sent` payload is
   stored for this account: `event` has no payload column, and `webhook_delivery` holds only those 59 and 4
   `messages.deleted`. So whether live outbound payloads carry `queueId` is unknown; if they do, each live DM stays
   mass until a backfill re-derives it. `isFromQueue` is true on 6,404 of 6,404 mass rows and on 322 non-mass
   outbound rows, 321 of them the 10-09 bulk send (this doc §3, caveat 2).
   **Resolved after 0e9ae31 (review-loop round 2): live rows use `isFromQueue`.** On both live accounts (2026-10-09)
   it is true on 6,512 of 6,512 mass rows and on 733 non-mass outbound rows: 683 share a queue id across 2 to 321
   chats (broadcasts outside the mass history a run read), 50 are single-chat queued sends. Residual: those ~0.2% of DMs (50 of
   26,133) count as mass until the next backfill over their range.

## 3. Data in hand

| Item | Count | Source |
|---|---|---|
| 90-day run, `--from 2026-07-11 --to 2026-10-10` | 3,686 requests, not stopped; 1,347 chats, 35,099 messages read, 1,311 broadcasts, 173 transactions | log |
| `message_fact` in the window | 33,390 rows (9,203 fan, 17,669 DM, 6,404 mass, 114 welcome); 1,349 chats; 2026-07-14..10-09 02:40 UTC | report |
| `purchase_fact` in the window | 173 rows, 66 fans, 2026-07-14..10-07. Booked $3,728.52 (net $2,982.79); settled 144 rows, $2,825.52 (net $2,260.39); `loading` 29 rows, $903.00 (net $722.40) | SQL |
| CLI CSVs | `messages.csv` 33,390, `chats.csv` 1,347, `transactions.csv` 173, `reply_times.csv` 6,923 | log |
| Exports, `to=2026-10-08` | `messages-all.csv` 33,038, `fan-replies.csv` 9,172, `our-messages.csv` 23,866, `chats/` 1,349 files, `fans.json` 1,000 of 1,349 (route limit) | `wc -l` |

| Kind | Settled (`done`) | `loading` | Booked | Net of booked | Fans |
|---|---|---|---|---|---|
| message (PPV) | 112 tx, $2,455.12 | 18 tx, $765.00 | 130 tx, $3,220.12 | $2,576.08 | 55 |
| tips | 13 tx, $226.28 | 11 tx, $138.00 | 24 tx, $364.28 | $291.42 | 13 |
| post | 8 tx, $87.99 | none | 8 tx, $87.99 | $70.39 | 8 |
| subscription | 11 tx, $56.13 | none | 11 tx, $56.13 | $44.90 | 10 |

Handoff §4 (2026-10-08 22:41 UTC) counted 111 settled and 19 `loading` message payments: one has settled since.

- **Chats 1,347 vs 1,349:** 2 chats hold only 34 live-event rows (10-08 23:19..10-09 01:18 UTC) and no coverage row.
- **Queue ids 17,124 vs 17,122:** 17,124 = this window's distinct ids on non-mass outbound rows; 17,122 counted DM ids before 10-09.
- **messages.csv 33,390 vs CSV 33,038:** the CLI file runs to 10-10; the export stopped at `to=2026-10-08`, 352 rows short.

**Quality caveats.**

1. **Unmatched queue ids are ordinary DMs.** Every message has a queue id, fan messages too; 17,118 of 17,123 DM ids
   sit in one chat. Mass history lists broadcasts only, so the log's counter counted DMs (the counter was removed in review-loop round 2).
2. **Bulk sends are stored as DMs.** 15 exact texts each reached 20+ chats and 5 queue ids are shared by 8 to 321
   chats: 1,872 rows, 10.6% of DMs. The largest are two texts to 497 and 498 chats (09-14..09-21) and the 10-09 02:39
   UTC send (hypothesis: a mass message; one queue id, 321 chats in 27 s, `isFromQueue` true), which mass history,
   read once at the run's start 4.5 h earlier (`backfill.ts`), could not list. Mass history covers up to the run's
   start only: a broadcast sent during a run stays stored as DMs until the next run over its day.
3. **Incomplete chats: mostly a false alarm, fixed.** The log flags 1,224 of 1,347. OF's last page of a chat's
   messages says `hasMore: true` and the page after it is `{"list":[],"hasMore":false}`; the walk stopped on that
   empty page without reading it as the chat's start, so `reached_start` stayed false (fixed 2026-10-09: the empty
   page now records it; a re-run sets it). In this run's rows: 113 proven complete (the oldest stored message is the
   welcome message, sent on subscribe), 7 with a fan quoting a message older than the oldest stored one, 1,104 unknown.
   Opener kind is "unknown" on 1,073 of 1,664 openers until that re-run.
4. **Unsent content vanishes, so unlock rates are upper bounds.** All 64 quoted-but-missing messages are ours, none
   bought (40 mass, 9 DM PPVs, 15 free DMs), 50 of them inside walked spans. The soft delete (62d3c50) has marked
   nothing yet: none of the 4 `messages.deleted` ids of 2026-10-09 was stored.

## 4. Handoff §5 compute list

**1. Revenue per fan.** Per-fan rows: kit `detail/d05-revenue-per-fan.csv`, outside the repo.

| Tier (booked, window) | Fans | Booked | Settled | Share of booked |
|---|---|---|---|---|
| $100 and up | 10 | $2,461.99 | $1,670.99 | 66.0% |
| $25–99.99 | 24 | $1,028.53 | $916.53 | 27.6% |
| under $25 | 32 | $238.00 | $238.00 | 6.4% |

Per paying fan: median $25.50, p90 $157.50; 34 of 66 paid twice or more. 18 payers ($1,444.17, 38.7%) have no stored
message at all, 6 of them in the top tier; 15 of the 18 carry `user.isDeleted=true` on the transaction ($1,428.17).
Hypothesis: they deleted their OF accounts, so the chat list no longer shows them. A whale list must start from
`purchase_fact`, not from chats.

**2. PPV conversion.** DM PPVs: 72 of 435 opened (16.6%; $1,862.27 of $16,826.39 list price; 140 chats). Mass PPVs:
14 of 14 ($95.96), because only bought mass copies survive (this doc §3, caveat 4). Cross-check against
`purchase_fact` kind `message`, matched one-to-one (this doc §8): consistent on 86 pairs from 40 fans. 86 of 86 opened
PPVs got a payment, no unopened PPV got one, and matched payments equal the opened list price ($1,958.23). The other
44 payments ($1,261.89, 15 fans) have no stored PPV, and none of those 15 fans has a stored message. Send to payment:
under 1 min 26, 1–10 min 35, 10–60 min 7, 1–24 h 13, over 24 h 5 (median 143 s, p75 18 min, p90 14.9 h).

**3. Per-fan reply rate.** The fan wrote in 390 of 1,349 chats (28.9%); 959 never wrote. With bulk sends counted as
mass, 569 of those 959 got a real DM, and the other 390 got only bulk, mass or welcome messages.

**4. Fan response latency.** 6,709 fan messages directly after our DM: median 76 s, p75 262 s, p90 1.0 h; 76.6%
arrive within 5 minutes and 90.1% within 1 hour.

**5. Our reply time and SLA** (routes, UTC days). Median 82 s, p90 842 s, SLA 90.1% (6,235 of 6,923 turns, 3
pending). Worst days with 20+ turns: 2026-09-19 (53.3%) and 09-21 (58.1%). By hour, SLA runs from 84.9% to 95.1%.
The window ran at UTC+2 throughout (handoff §7 question 3).

**6. Conversation length** (6 h gap, mass excluded). 2,988 sessions in 1,349 chats: median 2 messages, p90 18, 60.7%
with 2 or fewer. With bulk sends also excluded: 1,931 sessions, median 3, p90 31, 45.8% with 2 or fewer.

**7. Best hours** (Europe/Ljubljana). Purchases are message and tip payments, payers without a chat included.

| Local hours | Fan messages | DMs without bulk | Purchases | Booked | Settled | Share of booked | Buyers |
|---|---|---|---|---|---|---|---|
| 00–05 | 2,946 (32.0%) | 4,799 | 71 | $1,588.94 | $1,221.94 | 44.3% | 30 |
| 06–11 | 1,697 (18.4%) | 2,919 | 12 | $258.98 | $258.98 | 7.2% | 11 |
| 12–17 | 2,414 (26.2%) | 4,234 | 44 | $975.38 | $658.38 | 27.2% | 21 |
| 18–23 | 2,146 (23.3%) | 3,845 | 27 | $761.10 | $542.10 | 21.2% | 12 |

Fan messages peak at local 02:00 (624) and 16:00 (488). Hour by hour, local and UTC: the report's best-hours section.

**8. Drop-off points.** As stored (handoff query): 966 of 1,348 chats were silent 7+ days at the window end. Their
last non-mass message is ours and free in 941 (97.4%; 44 of those marked `not_available`), an unbought PPV in 14
(1.4%) and the fan's in 11 (1.1%). With bulk sends counted as mass: 898 of 959 are silent; the last message is ours and
free in 96.2%, an unbought PPV in 2.0% and the fan's in 1.8%.

**9. Reactivation.** 81 fan messages after 7+ silent days, from 63 fans, median gap 12.6 days. The peak is the week
of 2026-09-14 (26), when the two ~500-chat bulk texts went out; of the 857 chats that got a bulk text before 10-09,
126 had a fan message within 24 h. Openers route: 1,664 openers (46 first-ever, 545 reactivation, 1,073 unknown
kind); 209 replied, 1,134 no reply, 321 pending, and the 321 pending are the 10-09 bulk send.

**10. Media mix.** Item counts from `raw->'media'` types. GIFs include GIPHY (`giphyId`): 1,091 of the 1,092 GIFs,
none counted in `media_count` (handoff §6).

| Side | Messages | With media | Photos | Videos | GIFs | Audio |
|---|---|---|---|---|---|---|
| Fan | 9,203 | 234 | 126 | 24 | 108 | 0 |
| DM, free | 17,234 | 1,946 | 978 | 138 | 984 | 39 |
| DM PPV, sent | 435 | 434 | 1,685 | 315 | 0 | 0 |
| DM PPV, bought | 72 | 72 | 252 | 58 | 0 | 0 |
| Mass (only bought PPV copies have media) | 6,404 | 14 | 183 | 15 | 0 | 0 |

The 114 welcome messages carry no media.

## 5. Stats ideas, by build cost

Cost 0 = a route already returns it; A = SQL on `message_fact`; B = needs `purchase_fact`; C = needs a new source or
an owner answer. "Gap N" is handoff §8's list. DM-based numbers need the bulk label of this doc §1 item 4 first. The
last column is reference only (handoff §8), not a ranking input.

| # | Idea | Cost | This window | Shown by (reference) |
|---|---|---|---|---|
| 1 | Script reply rates, `/v1/stats/scripts` | 0 | 101 scripts, 2,175 sends in 2,174 sequences (reply outcomes count per sequence of DMs; one chat got one script twice in one). Outcomes per sequence: 460 replied + 1,235 no reply + 479 pending. Reply rate 27.1%; 34.1% (391 of 1,146) without the bulk texts | Infloww, Supercreator |
| 2 | Recency tags (❄️ 72 h, 7 days) from `lastFanAt` in `/v1/stats/fans`, UI only | 0 | 28 fans wrote in the last 72 h, 362 wrote in range but not in the last 72 h, 959 never wrote; the route returns 1,000 of 1,349 | Infloww, Supercreator |
| 3 | Creator persona corpus, gap 8: the `/v1/stats/messages` export | 0 | 16,534 DMs with text, about 569k characters, median 27; 14,662 without bulk. Sending it to an LLM waits on handoff §7 question 6 | Supercreator, Substy |
| 4 | Golden ratio (DM PPVs ÷ DMs) by day and hour, gap 1 | A | 2.46%, 2.75% without bulk; FansMetric's all-PPV version 1.86%; by local hour 0.97% (11:00) to 4.28% (01:00) | Infloww, FansMetric |
| 5 | Fans chatted per hour, gap 2 | A | median 2 chats DMed per active hour (max 321, the 10-09 bulk send); 13.1 DMs per fan chatted | Infloww |
| 6 | Each fan's active hours, gap 4 | A | 238 fans with 5+ messages: median 96.7% of their messages in their top 3 local hours; 72.7% send 80% or more there | Supercreator, GenieHelper |
| 7 | PPV timeline and unlock rate per fan, gap 5 | A | 145 fans got a PPV, 40 bought one; median 1 PPV per fan, p90 7. `/v1/stats/fans` already has `ppvSent` and `ppvOpened` | Infloww, Supercreator |
| 8 | Content stats per media key, gap 6 | A | 376 keys, 1,410 sends, 93 sent twice or more; 297 sold as PPV, 65 bought at least once, 28 bought and then sent again | Supercreator |
| 9 | PPV price ladder | A | DM PPVs paid: under $15 30 of 177 (16.9%), $15–29.99 19 of 142 (13.4%), $30 and up 23 of 116 (19.8%). The $200 price: 39 sends to 6 fans, none bought. Thin samples; price is confounded with the fan | Supercreator (claim), Infloww |
| 10 | Spend per fan, whale tier, 90-day LTV, gap 7 | B | this doc §4 item 1 | all |
| 11 | Fan CVR, chat AFV, $ per DM | B | 48 of 1,346 DMed fans paid (3.6%; 5.0% of 957 without bulk); 41 of 390 who wrote (10.5%). PPV plus tips of DMed fans: $2,155.23 ($1,754.23 settled): $1.60 per DMed fan and $0.122 per DM ($2.25 and $0.136 without bulk) | Infloww, FansMetric |
| 12 | Buyer tag (🔥) and time to unlock | B | 57 PPV or tip buyers, 5 of them bought in the last 7 days; the lag is in this doc §4 item 2 | Infloww, Supercreator |
| 13 | Best hours with money | B | this doc §4 item 7 | Supercreator, GenieHelper |
| 14 | Mass performance per broadcast | C | 1,311 broadcasts read, 14 bought copies stored; needs this doc §1 item 5 | Supercreator, Infloww |
| 15 | Subscription lifecycle: New, expired, renewals | C | `raw->'fromUser'` is only `{id,_view}`; 11 subscription payments; needs subscriber reads | Infloww, Supercreator |
| 16 | Per-chatter $/hour and converter credit | C | OF messages name no chatter; needs a `send_log` and shifts | Supercreator, Infloww |
| 17 | Per-fan memory through an LLM | C | 9,203 fan messages from 390 fans, 238 with 5+; waits on handoff §7 question 6 | Supercreator, Substy, GenieHelper |

**Retired:** predicted churn and LTV scores (66 payers are too few; YAGNI); drop-off, session length and win-back,
now handoff §5 items 6, 8 and 9 (this doc §4); the bulk-send label, now a prerequisite (this doc §1 item 4).

**Follow-ups** (code, not designed here): re-read mass history before a backfill ends; add handoff §5 item 10 to the
kit. Live mass by `isFromQueue` is done (this doc §2, bug 2); the backfill's unmatched-queue counter was removed.

## 6. Main (91610731) from stored rows

Kit SQL over Main's whole stored range, 2025-01-25..2026-10-05 (report of 2026-10-09 04:57 UTC in
`~/of-capture/chat-mining/91610731-90d/`, outside the repo). All 13 routes returned HTTP 400 `range_too_large`, and
`purchase_fact` holds 0 rows for Main, so there are no money, reply-time or opener numbers. @isaraee is shown for scale.

| Metric | Main, 2025-01-25..2026-10-05 | @isaraee, this window |
|---|---|---|
| Rows: fan / DM / mass / automated | 3,993 / 7,487 / 108 / 0 (11,588) | 9,203 / 17,669 / 6,404 / 114 |
| Chats; walked to their start | 87; 0 | 1,349; 54 (whole account) |
| Chats where the fan wrote | 81 (93.1%) | 390 (28.9%) |
| Fan response latency: median, p90, within 1 h | 813 s, 14.6 h, 67.6% | 76 s, 1.0 h, 90.1% |
| DM PPVs sent / opened | 154 / 0 (29 chats, $1,208.82 list) | 435 / 72 |
| Golden ratio | 2.06% | 2.46% |
| DMs per fan chatted; fan messages per fan who wrote | 99.8; 49.3 | 13.1; 23.6 |
| Sessions: count, median, p90, share with 2 or fewer | 2,076, 1, 8, 70.1% | 2,988, 2, 18, 60.7% |
| Chats silent 7+ days at the range end | 32 of 87 | 966 of 1,348 |
| Returns after 7+ silent days | 138 from 48 fans, median gap 13.4 days | 81 from 63 fans, 12.6 days |
| Fans with 5+ messages; median share in their top 3 hours | 69; 50.0% | 238; 96.7% |
| Persona rows with text | 7,482 (about 243k characters) | 16,534 (about 569k characters) |

No PPV is opened and no transaction is stored, so "opened" cannot be checked on Main. No clock hour reached 100+ chats,
so no bulk send shows.

## 7. Open questions (handoff §7)

1. **Booked or settled?** They differ by $903.00 gross ($722.40 net) in 29 `loading` rows as of 2026-10-09 04:51 UTC.
   This doc shows both.
2. **Re-connect Main?** Stored rows give message stats only (this doc §6); money, reply time and openers need a live
   session and a backfill.
3. **Which timezone?** Routes group by UTC; the window ran at UTC+2 throughout (CEST ends 2026-10-25). The kit uses
   Europe/Ljubljana.
4. **Is 90 days enough?** LTV covers 90 days only, and opener kind is "unknown" on 1,073 of 1,664 openers because
   this run's walks did not record reaching the chat start (this doc §3, caveat 3: fixed, a re-run records it).
5. **Which automations or bots send?** Only the welcome message (114 rows) is flagged. Candidates: 15 texts sent word
   for word to 20+ chats (largest 497 and 498 chats, 2026-09-14..09-21), 4 queue ids shared by 8 to 174 chats
   (2026-09-21..09-29) and the 10-09 bulk send. Linked: do bulk sends count as DMs for golden ratio and Fan CVR? This
   doc shows both until then.
6. **May fan text leave this machine?** It gates ideas 3 (if sent to an LLM) and 17 of this doc §5.

Answered, so dropped: what the mining is for (handoff §1: store all data first); whether "opened" means bought (this
doc §4 item 2); a soft delete for unsends (shipped in 62d3c50).

## 8. Appendix: reproduce

1. `source ~/of-capture/chat-mining/env.sh` (outside the repo). It sets `GW`, `KEY`, `TEAM`, `ACC`, `OUT`; never print `KEY`.
2. `select count(*), count(kind) from purchase_fact where account_id=337749380;` must return two equal numbers.
3. `~/of-capture/chat-mining/kit/run.sh 337749380 2026-07-11 2026-10-09` writes `report-<UTC>.md` to `$OUT`. `TO` is
   inclusive: routes get `to=TO`, SQL uses `< TO + 1 day`.
4. Run the match below and compare with this doc §3 and §4.
5. Re-export with `/v1/stats/messages?accountId=337749380&from=2026-07-11&to=2026-10-09&format=csv`, outside the repo.

**Opened = bought, one-to-one.** Create view `m` from handoff §5 (same bounds). Payments are taken in time order, and
each takes the latest still-unmatched PPV of the same fan and price sent at or before it:

```sql
with recursive
pay as (select row_number() over (order by created_at, tx_id) i, fan_id, gross_cents, created_at from purchase_fact
  where team_id='bc407cc9-d7cd-499a-87fe-58a04e67f71a' and account_id=337749380 and kind='message'
    and created_at >= '2026-07-11T00:00Z' and created_at < '2026-10-10T00:00Z'
    and coalesce(raw->>'status','') not in ('undo','pending_return')),
ppv as (select message_id, chat_id, price_cents, created_at, (raw->>'isOpened')::boolean opened
  from m where direction='outbound' and price_cents>0),
r(i, ppv_id, used) as (select 0::bigint, null::bigint, array[]::bigint[] union all
  select pay.i, x.message_id, case when x.message_id is null then r.used else r.used || x.message_id end
  from r join pay on pay.i = r.i + 1 left join lateral (select v.message_id from ppv v where v.chat_id = pay.fan_id
    and v.price_cents = pay.gross_cents and v.created_at <= pay.created_at and v.message_id <> all(r.used)
    order by v.created_at desc, v.message_id desc limit 1) x on true)
select (select count(*) from ppv where opened) opened_ppvs, count(*) filter (where ppv.opened) matched_opened,
  count(*) filter (where not ppv.opened) matched_unopened, (select count(*) from pay) - count(*) unmatched_payments
from r join ppv on ppv.message_id = r.ppv_id;
```

On 2026-10-09 it returned 86, 86, 0 and 44.
