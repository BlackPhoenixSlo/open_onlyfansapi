# Handoff: store all chat data for 337749380 (90 days)

Updated 2026-10-08 22:45 UTC (2026-10-09 local) after the owner's answers. Background: [docs/analytics.md](docs/analytics.md)
(see "Stored messages and export" for every export field), [docs/analytics-backfill.md](docs/analytics-backfill.md),
[spec §2](docs/spec/future-client-story-ask.md).

## 1. Goal

Store **all** chat data for @isaraee now: every message's text, its PPV price and whether it was bought, tips,
photo/video/gif/audio counts, plus every transaction. It gets investigated later. Stats ideas come after the data is
in. Window: 2026-07-11..2026-10-09 (UTC).

## 2. State of the store

As of 2026-10-08 22:41 UTC. Workspace `jaka-basej-ehpyuz`, team `bc407cc9-d7cd-499a-87fe-58a04e67f71a`.

| Account | OF session | `message_fact` | `purchase_fact` |
|---|---|---|---|
| 337749380 = @isaraee (Isabelle Rae) | working | 13,805 rows (13,698 in the window, 662 chats), growing while the run walks | 173 rows, 2026-07-14..2026-10-07, see §4 |
| 91610731 = Main (@jakabasej) | **dead** since 2026-10-08 | 11,588 rows, 2025-01-25..2026-10-05 | 0 rows |

Main can only be mined from what is stored, until someone re-connects it on Accounts.

## 3. Runbook

**Nothing needs an API key.** The CLI reads the repo root `.env` (`--env-file-if-exists=../../.env` in
`apps/api/package.json`), which must set `DATABASE_URL`, `UPSTREAM_URL` and `UPSTREAM_TOKEN`. The dashboard uses your
login.

**Step 1: the 90-day run is already going. Do not start another run on 337749380.** The owner's other session
started it on 2026-10-08 at 22:13 UTC:

```sh
pnpm --filter @gateway/api analytics:backfill --account 337749380 --from 2026-07-11 --to 2026-10-10 --out ~/of-capture/chat-mining/337749380-90d
```

- **Log.** `~/of-capture/chat-mining/337749380-90d/backfill.log` holds only a start line, then a final summary
  (`requests: N; stopped: no`, then `chats N, messages N, broadcasts N, transactions N, ...`). When the run ends it
  also writes four CSVs to that folder.
- **Second run.** A 3-day diagnostic run on the same account (`--from 2026-10-06 --to 2026-10-09`, log
  `/tmp/chat-mining/backfill-3d.log`) ran alongside it and was stopped on 2026-10-09 after writing
  `/tmp/chat-mining/run-3d` (3,669 messages, 662 chats, 9 transactions). Its upsert used pre-551e282 code, so
  `kind` for 2026-10-06..09 is null until the restore in step 2.3 runs.
- **Duration.** Many hours. A 3-day window already meant about 460 active chats, and the 600/h cap was hit after
  about 17 minutes. Each active chat costs at least one 100-message page, plus chat-list pages (about 10 chats each)
  and one mass-history window per day.
- **Progress.** Run this in `psql postgres://gateway:gateway@localhost:5434/gateway`. It returned 662 at 22:41 UTC:
  `select count(*), max(walked_at) from chat_coverage where account_id=337749380 and walked_at > now() - interval '6 hours';`
- **If it dies** (session expired, machine sleep): check the account is `active` on Accounts, then re-run the same
  command. Rows upsert, but there is no resume.

**Step 2: after the run ends, let the transaction-kind watcher finish.** Both running CLIs loaded code from before
551e282 (purchase kind fix) and ac9761d (transactions read first). When they end, they re-read transactions with the
old code, and that upsert sets `purchase_fact.kind` to null.

- **The watcher.** `/tmp/chat-mining/restore-kind.sh` (log `/tmp/chat-mining/tx-restore.log`) waits for both runs to
  exit. It then runs `/tmp/chat-mining/tx-only.mts 2026-07-11 2026-10-10`, which is the fixed backfill stopped as
  soon as the transactions (read first) are stored, in about 3 requests.
- **Check.** `select count(*), count(kind) from purchase_fact where account_id=337749380;` should show two equal
  numbers.
- **If `/tmp` was wiped**, use the shipped CLI over the **same** 90-day range:
  `pnpm --filter @gateway/api analytics:backfill --account 337749380 --from 2026-07-11 --to 2026-10-10 --out /tmp/tx-redo`.
  As soon as the check query shows the counts equal, press Ctrl-C. Transactions are read first, so this takes
  seconds; the CLI then writes its CSVs and exits.
- **Why not a 1-day window.** It would not do this. `readTransactions` (`apps/api/src/modules/analytics/backfill.ts`)
  keeps only rows inside `[from, to)` and stops at the first page older than `from`, so a 1-day window restores one
  day.

**Step 3: export from the dashboard.** Open
`http://localhost:5174/stats?range=custom&from=2026-07-11&to=2026-10-09&accountId=337749380`. `to` is inclusive. In
the **Fans** card:

- **Download all messages (CSV)**: every message, both sides.
- **Download fan replies (CSV)**: the fans' messages only.
- **CSV** on a fan's row: that fan's conversation.

Save the files to `~/of-capture/chat-mining/337749380-90d/` and keep them out of the repo, because they hold fan
ids and fan text.

- **Columns.** `account_id`, `chat_id`, `fan_username`, `message_id`, `created_at`, `direction`, `text`,
  `price_cents`, `is_free`, `is_opened`, `is_tip`, `tip_cents`, `media_count`, `photos`, `videos`, `gifs`, `audios`,
  `has_preview`, `is_mass`, `is_automated`, `is_reply`, `is_liked`, `deleted_at`. What each one means is in the
  docs table, not repeated here.
- **Fan rows.** The card's fan list also shows PPV bought/sent and tips.
- **Format.** Streamed, plain UTF-8, LF line endings, the whole range. `pd.read_csv` reads it directly.
- **Splitting.** A conversation per fan is just a filter on `chat_id` in the full file. Do not click every row.

**Fallback: export with psql**, for raw OF HTML or fields the CSV lacks. Use view `m` from §5:
`\copy (select m.chat_id, c.fan_username, m.created_at, m.direction, m.price_cents, m.raw->>'isOpened' bought, m.deleted_at, m.raw->>'text' text_html, m.raw->'media' media from m left join chat_coverage c using (team_id, account_id, chat_id) order by 1,3,m.message_id) to '~/of-capture/chat-mining/337749380-90d/messages-raw.csv' csv header`

Optional¹: the same CSV over HTTP.

## 4. Money (`purchase_fact`)

**Root cause of the earlier 0 rows.** The backfill read transactions last, after hours of chat walks, and no run
lived long enough to reach them. ac9761d reads them first.

337749380 now has 173 rows for 2026-07-11..2026-10-10, gross **$3,728.52**:

| `kind` | `raw->>'status'` done | loading | Gross |
|---|---|---|---|
| message (PPV) | 111 | 19 | $2,400.12 + $820.00 |
| tips | 13 | 11 | $226.28 + $138.00 |
| subscription | 11 | 0 | $56.13 |
| post | 8 | 0 | $87.99 |

Every revenue query must filter on status:

- Exclude `undo` and `pending_return` (refunded or reversed). None were stored yet, but OF has them.
- `loading` is booked but not yet paid out, 30 of the 173 rows. Report it in its own column ("settled" =
  `done`, "booked" = `done` plus `loading`) until the owner decides (§7).
- All 173 rows have `fan_id` from the transaction's `user.id` (`fan_id_source='field'`). `fan_id` equals
  `message_fact.chat_id`.
- 66 fans paid. On 2026-10-08 only 33 of them had messages stored in the window, because the walk was still running.

## 5. What to compute first

Create the view in psql. Every query below was tested on 2026-10-08:

```sql
create temp view m as select *, (direction='outbound' and not is_mass and not is_automated) is_dm from message_fact
where team_id='bc407cc9-d7cd-499a-87fe-58a04e67f71a' and account_id=337749380 and created_at >= '2026-07-11T00:00Z' and created_at < '2026-10-10T00:00Z';
```

1. **Revenue per fan**: settled and booked spend per fan, next to how much they chat. This is the base for LTV,
   whales and big-spender coverage. The top fan on 2026-10-08: $641 booked, 267 fan messages, 347 DMs.
   ```sql
   with p as (select fan_id, count(*) n, sum(gross_cents) filter (where raw->>'status'='done') done_c, sum(gross_cents) all_c from purchase_fact where team_id='bc407cc9-d7cd-499a-87fe-58a04e67f71a' and account_id=337749380 and created_at >= '2026-07-11T00:00Z' and created_at < '2026-10-10T00:00Z' and coalesce(raw->>'status','') not in ('undo','pending_return') group by 1)
   select p.fan_id, c.fan_username, p.n, p.done_c/100.0 settled_usd, p.all_c/100.0 booked_usd, f.fan_msgs, f.dms from p left join chat_coverage c on c.team_id='bc407cc9-d7cd-499a-87fe-58a04e67f71a' and c.account_id=337749380 and c.chat_id=p.fan_id left join (select chat_id, count(*) filter (where direction='inbound') fan_msgs, count(*) filter (where is_dm) dms from m group by 1) f on f.chat_id=p.fan_id order by p.all_c desc;
   ```
2. **PPV conversion**: priced outbound messages against those with `isOpened`, which on a priced message means
   bought (docs table).
   - 2026-10-08 result: DM PPVs 39 of 183 bought (21.3%, $1,212.74). Mass PPVs 5 of 5 (check those by hand).
   - Cross-check bought dollars against `purchase_fact` kind `message`.
   `select is_mass, count(*), count(*) filter (where (raw->>'isOpened')::boolean) bought, round(100.0*count(*) filter (where (raw->>'isOpened')::boolean)/nullif(count(*),0),1) pct, sum(price_cents) filter (where (raw->>'isOpened')::boolean)/100.0 usd from m where direction='outbound' and price_cents>0 group by 1;`
3. **Per-fan reply rate**: the share of fans reached who ever wrote back. It separates the base worth chatting to
   from the broadcast-only base.
   `select count(*), count(*) filter (where fan>0) from (select chat_id, count(*) filter (where direction='inbound') fan from m group by 1) f;`
4. **Fan response latency**: time from our DM to the fan's next message. It shows when fans are live, which is
   when to upsell.
   `select percentile_cont(array[.5,.9]) within group (order by extract(epoch from created_at-p)) from (select *, lag(created_at) over w p, lag(is_dm) over w pdm from m window w as (partition by chat_id order by created_at, message_id)) x where direction='inbound' and pdm;`
5. **Our reply time and SLA**: already built.
   `GET /v1/stats/metrics/reply_time?accountId=337749380&from=2026-07-11&to=2026-10-09&groupBy=day`, or the same
   numbers on the Stats page.
6. **Conversation length**: messages per session, where a session ends after a 6 h gap and mass is excluded.
   `select width_bucket(n,1,101,10), count(*) from (select chat_id, s, count(*) n from (select chat_id, sum(case when p is null or created_at-p>interval '6 hours' then 1 else 0 end) over (partition by chat_id order by created_at, message_id) s from (select chat_id, created_at, message_id, lag(created_at) over (partition by chat_id order by created_at, message_id) p from m where not is_mass) a) b group by 1,2) c group by 1 order by 1;`
7. **Best hours**: fan messages, DMs, PPVs and bought PPVs by local hour (timezone: §7).
   `select extract(hour from created_at at time zone 'Europe/Ljubljana') h, count(*) filter (where direction='inbound') fan, count(*) filter (where is_dm) dm, count(*) filter (where price_cents>0 and direction='outbound') ppv, count(*) filter (where (raw->>'isOpened')::boolean and price_cents>0) bought from m group by 1 order by 1;`
8. **Drop-off points**: in chats silent for 7 or more days before the window ends, the last non-mass message, by
   sender and type.
   `select direction, price_cents>0 ppv, raw->>'isOpened', count(*) from (select distinct on (chat_id) * from m where not is_mass and not is_automated order by chat_id, created_at desc, message_id desc) l where created_at < '2026-10-03T00:00Z' group by 1,2,3 order by 4 desc;`
9. **Reactivation**: fans who wrote again after 7 or more days of silence, per week. Pair it with opener kind
   `reactivation` from `GET /v1/stats/metrics/openers`.
   `select date_trunc('week', created_at)::date, count(*) from (select created_at, created_at-lag(created_at) over (partition by chat_id order by created_at, message_id) g from m where direction='inbound') x where g >= interval '7 days' group by 1 order by 1;`
10. **Media mix**: photos, videos, gifs and audio sent per side, and in bought PPVs. Read from `raw->'media'`
    (`type` is `photo`, `video`, `gif` or `audio`), or the CSV's `photos`, `videos`, `gifs`, `audios`.

For Main, recreate `m` with `account_id=91610731`.

## 6. Gotchas

- **Session expiry.** An OF 401 or "Wrong user" stops a run (`session_expired`). Main died this way on 2026-10-08.
- **Run status.** Route and dashboard runs live in the API's memory and die on a `tsx watch` restart. CLI runs are
  separate processes, and the API's one-run guard does not see them.
- **Rate limits.** OF documents none. The 600/h cap is a guess, and each run counts its own cap from zero.
- **Unsent messages.** A `messages.deleted` event keeps the row and sets `deleted_at` (migration `0012`, 62d3c50).
  A later backfill that reads the message again clears the mark. Metrics still count marked rows, and the export
  shows `deleted_at`.
- **Not stored.** The media files themselves (only counts and ids are kept), and subscription details per fan:
  `raw->'fromUser'` is only `{id,_view}` on nearly every fan row.
- **Coverage.** Few chats are walked to their start, so most openers have kind `unknown`.
- **GIPHY gifs.** They have `giphyId` and empty `media`: the export's `gifs` counts them, but `media_count` does not.

## 7. Open questions for the owner

1. Is `loading` revenue counted (booked), or only `done` (settled)?
2. Should Main (91610731) be re-connected and mined too, or is @isaraee enough?
3. Which timezone should hour-of-day stats use: the agency's (e.g. Europe/Ljubljana) or the model's?
4. Is 90 days enough, or should the CLI go further back? It takes any range, but cost grows with chat count.
5. Which automations or bots send on @isaraee? Their texts make `is_automated` accurate (`--automation <file>`).
6. May fan text leave this machine later, for example to an LLM for tagging or summaries?

## 8. Reference only: what AI chatter tools expose

Not needed for the data gathering. This is for when the stats get designed.

| Tool | Per-fan data | Metrics | Ingestion / AI | Sources |
|---|---|---|---|---|
| Supercreator (Izzy) | purchases, LTV, spend tier, lists, gone quiet, notes/tags, closing chatter | per chatter $/h, conversion, response time, PPVs; per content unlock rate; churn, whales | apps, history imported on connect; AI learns fan history and creator style, picks PPV, price and timing (claim) | [fan-crm](https://www.supercreator.app/onlyfans-crm/fan-crm), [chatters](https://www.supercreator.app/onlyfans-crm/chatter-management), [analytics](https://www.supercreator.app/onlyfans-crm/revenue-content-analytics), [ai](https://www.supercreator.app/ai-chatter) |
| Infloww (client's CRM) | spend since added, purchase rate, last/highest spend, subscription, PPV timeline; tags New/🔥/❄️ 72 h/expired | golden ratio, unlock rate, Fan CVR, response time, converter credit | desktop app proxying the session; Copilot beta; event automations | [fan insights](https://help.infloww.com/en/articles/418759-fan-insights-panel), [messages pro](https://help.infloww.com/en/articles/262067-getting-started-with-onlyfans-messages-pro), [employee](https://help.infloww.com/en/articles/262078-employee-reports), [fan reports](https://help.infloww.com/en/articles/276167-fan-reports) |
| Substy | fan context, Spender/VIP/Newbie/Timewaster classes (vendor blog) | creator and employee stats, response rate, basket | API and webhooks; tone and persona, PPV, negotiation (claim) | [substy.ai](https://substy.ai/), [API](https://docs.substy.ai/reference), [blog](https://substy.ai/blog/best-onlyfans-crm-for-agencies-in-2026-the-complete-comparison-guide) |
| GenieHelper² | 71 claimed fields, `fan_memories` | churn and LTV scores (no formulas) | Playwright and cookies; local LLM with per-fan memory | [fan-crm](https://mintlify.wiki/kismetkanceled/geniehelper/platform/fan-crm) |
| FlirtFlow, FansMetric | memory (claim); n/a | n/a; Chat AFV, $/message, unlock ratio, golden ratio | autonomous PPV (claim); n/a | [flirtflow.ai](https://www.flirtflow.ai/), [fansmetric](https://intercom.help/fansmetric/en/articles/9207508-chatter-analytics) |

Gaps the stored data can already fill, cheapest first:

1. golden ratio, using `count(*) filter (...)` with `nullif`
2. fans chatted per hour
3. recency tags from `lastFanAt`
4. each fan's active hours
5. PPV timeline and unlock rate from `isOpened`
6. per-media stats by `media_key`
7. spend per fan, LTV, whale tier and converter credit, from `purchase_fact`
8. a creator persona corpus: outbound rows with `is_mass=false` and `is_automated=false`

These need new data: the subscription lifecycle, per-chatter numbers (`send_log` plus shifts), and predicted scores.

---
¹ Optional, needs an API key: `curl -fsS -H "Authorization: Bearer $KEY" "localhost:4000/v1/stats/messages?accountId=337749380&from=2026-07-11&to=2026-10-09&format=csv" -o messages-all.csv`.
² A Mintlify auto-wiki of the GitHub repo `kismetkanceled/geniehelper`, not a commercial product.
