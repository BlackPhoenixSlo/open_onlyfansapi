# Plan v6: reference-API parity — open rows, content, promo and settings

Build plan after plan-v5 (merged; tag v2.0.0 at bc2220b; master e49ebc6 = origin/master), for one Opus implementer
on **one wave** (branch `v6/parity`). v6 adds **named per-account routes only**: it closes what it can of the 26 `?`
rows and the 10 `deferred-write` rows v5 left open, and of the groups v5 deferred (content, promo, settings). v6
changes no plan-v5 §2 contract (wrapper, `x-next-page`, event names, passthrough, signing), adds no event, migration or
env var, and ships as **v2.1.0** (additive, §7). Principles: **YAGNI** (no new abstraction beyond what a route needs)
and **no guessing**: a GET ships when its OF call is sourced or a derived candidate passes a read-only probe (§3); a
write ships only under the rule in §1.2.

**Size.** 32 operations ship on sources alone; 20 more ship only if their probe passes; 108 operations stay `?` (§4). After the §3
probes: 43 operations ship and 117 stay `?` (§4). After the implementation review: 41 ship and 119 stay `?`
(`GET notifications` and `DELETE bundles/{bundle_id}` moved to `?`, §4).

**Known gaps after v6** (a client written for the reference API hits these):
- The 104 `?` rows (108 operations) below, plus any probe-gated row whose probe fails. They are reachable only
  through `_of/` in OF's own paths and shapes, and only when OF has such a call: the 22 rows marked *ref* are
  probably the reference's own features (stored links, link tags, analytics, its session record).
- Media transfer: uploads, upload status, vault upload, URL scrape, CDN and DRM downloads, and the `media_uploads.*`
  events (§8).
- Everything plan-v5 lists as a known gap that v6 does not touch: the connect flow, `acct_…` ids, error bodies,
  team-level routes, `analytics/*`, `_meta` contents, webhook endpoint options, key `permission_level` and
  `account_scope`, poll-derived and TBC events.

**Canonical row table.** For the content, promo and settings groups and the v5 open rows, this plan's tables and
`?` lists are canonical (method, tail, OF call, status). `docs/spec/plan-v5-inventory.md` stays canonical for the v5
groups. After the wave, the orchestrator adds a "v6 execution notes" section to it.

**Overrides.** None of plan-v5 §2. §2 below adds rules that apply to v6 routes only. Where this plan says nothing,
plan-v5 applies. §1.8.1 is the only change to a v5 route, a bug fix.

## 0. Baseline (2026-10-04, master e49ebc6)

- **Upstream `/of` operations: 73** (`docs/spec/parity/baseline.txt`): the 4 v4 content operations and 69 from
  P2–P4. In-scope reference operations: **239** (233 per-account lines; a `PUT,PATCH` line is two operations).
  **Missing: 166**, all of them inside v6's scope (v5 open rows 37 + content 56 + promo 43 + settings 30).
- **Sources for OF calls.** v6 maps a reference route only from these:
  1. `OFClient` (`services/upstream/of_client.py`). Each method's docstring names its OF path; some also mark the
     body VERIFIED or CONFIRMED live (§1.2).
  2. The owner's captured OF endpoint names: 72 `GET_api2_v2_<path>.md` file names under the extension's
     `library/of_api_reference` (a `/` in the path is written `_`, so a decoded path can be wrong; every row sourced
     only from a file name is probe-gated, §3). **File names only:** the contents hold PII and are never read.
  3. v5 code.

  The reference OpenAPI copy in `~/of-reference` gives query, body and response **key shapes** only. It names no OF
  path (zero `api2` mentions).
- **The reference's `_pagination`** appears on the yaml operations for tracking and trial links, stored links,
  release forms, users/blocked, users/restricted and the engagement lists. Our wrapper already emits it from
  `x-next-page` (plan-v5 §2.2).
- **Versions.** Root `package.json`, `apps/api/package.json` and `services/upstream/app.py:77` still say 1.0.0;
  v2.0.0 was a CHANGELOG entry and a tag only, and `CHANGELOG.md`'s 2.0.0 heading still says "Unreleased". The v2.1.0
  release commit fixes both (§7).
- **`pnpm prepublish-check`** fails only on check 2b (`services/` is tracked), as expected.

## 1. Decisions

1. **Row status.** Every v6 row has exactly one status:
   - *have*: served before v6 (the 4 v4 content routes).
   - **S** (sourced): the OF call comes from an `OFClient` method, a captured OF endpoint name or v5 code, and the
     reference semantics map onto it directly. A write is S only under §1.2. Ships.
   - **S·gate**: an S GET sourced only from a decoded file name (v5 #17, #19, #22) or whose filter OF may ignore
     (settings #14). Ships only if its gate probe passes (§3); otherwise it becomes `?`.
   - **L** (live-resolve): a candidate OF **GET** derived from a sourced call: a sibling path on the same OF resource,
     a key inside a sourced response, or a sourced call with a derived parameter. Ships only if its probe passes on
     the connected account; otherwise it becomes `?`. A write is never L.
   - **`?`**: no source for the OF path, or (writes) no verified body or effect. Not implemented; passthrough only.
     **`?ref`** marks rows that are probably reference-side features: no OF call is expected, so the passthrough
     cannot reach them either.
   - **out**: not in v6 (§8).

   "Probe-gated" below means L and S·gate together.
2. **No guessing, and the write rule** (stated once; §2.2 only applies it):
   - An unsourced OF path or body is `?`, and the wave reports it. v6 adds one thing: a read-only GET probe may
     confirm a derived GET candidate. Probes never send a write and never touch `banking/*`.
   - **An unverified PATH may ship; an unverified BODY or value mapping may not.** A wrong path answers 404 and
     writes nothing. A wrong body field or value can be silently ignored by OF (it sends a `chats/{id}/messages`
     with `scheduledDate` immediately, `of_client.py:1887-1889`), so it is never assumed.
   - A body field or value ships only where `of_client.py` marks that body **VERIFIED** or **CONFIRMED** live. Every
     other reference field is declared, and the handler raises `ApiError(422, "unsupported_field", …)` only when its
     value differs from its no-op default. On a **create** body the no-op values are absent, `null`, `""`, `[]` and
     `false`, so a reference client that always sends `rfTag: []` or `saveForLater: false` is not rejected. On an
     **update** body (`POST settings/profile`) only absent and `null` are no-ops: `""` there means "clear", so `""`
     on an unverified field is a 422 too.
   - A write whose required reference fields have no verified mapping is `?`. So is a write whose **effect** is
     unverified even with no body: `pin_post` (OF's message pin is a toggle that unpins a pinned message and still
     answers success, `of_client.py:1303-1316`; nothing says whether the post pin is), and `edit_post` (an
     unverified `PUT` may replace the whole post, so a text edit could drop its media or price).
   - A body-less `DELETE` on a sourced path ships under the path rule: `delete_post`, `delete_story`,
     `delete_tracking_link`, `delete_trial_link`, `delete_promo`, `delete_bundle`. `create_bundle`, `create_promo`
     and `create_trial_link` have unverified bodies, so their rows are `?`.
3. **One wave.** Branch `v6/parity`, one worktree, one implementer, merged once (§6). It contains the S GET rows, the
   probe-gated rows that pass, and the writes §1.2 allows. It edits `chats.py`, `fans.py`, `money.py`, `content.py`
   and the two new modules `promo.py` and `settings.py`, which the orchestrator creates empty first, so the wave does
   not edit `routes/__init__.py`.
4. **Media transfer stays out** (§8): uploads for the same reasons as v5, plus binary downloads, URL scrape and DRM.
5. **Writes are fixture-tested only.** No POST, PUT, PATCH or DELETE reaches a real account in v6.
6. **Release v2.1.0** (§7): additive. Nothing in v6 is breaking. §7 lists what would be, and why that would mean
   v3.0.0.
7. **Mapping notes found while planning** (where the inventory's `client:` notes are wrong or missing):
   - `PATCH settings/welcome-message` (yaml body `{enabled}`) is the master switch `set_reply_on_subscribe`, not
     `upsert_welcome_template`. The row stays `?` (§1.2), but a later wave uses this call.
   - `GET release-forms/taggable-users` is `tagged_friend_users` (`posts/tagged-friend-users`); the inventory has no
     note for it.
   - `DELETE fans/{fan_id}/notes` was `deferred-write` in v5, but `set_fan_note(fan_id, "")` clears the note
     (VERIFIED LIVE, `of_client.py:2012-2023`).
   - The captured `stories/users/blocked` is the story block list, not `users/blocked`.
8. **Fixes to v5 routes in this wave** (bugs found in review; not breaking, §7):
   1. **Offset ignored, so `x-next-page` loops.** `engagement/messages/mass-messages` (`money.py:88-99`) and
      `mass-messaging/overview` (`chats.py:195-207`) page `users/me/stats/messages/group` by `offset`. OF ignores
      `offset` there and always reports `hasMore` (`of_client.py:765-768`), so `shape.py:25`'s full-page rule sets
      `x-next-page` on every full page and a client following `_pagination.next_page` re-reads page 1 forever.
      `of_client.py:765-768` already records this as verified (the 2026-07-04 incident). **Fix:** both handlers stop
      calling `next_page` (no `x-next-page`), unless P16's `group` check shows offset advancing, in which case
      nothing changes. `offset` stays declared, because removing it would change a v5 query (§7).
   2. **Reference cursor parameters on this wave's new routes** (`from_id` on notifications (not shipped after the review), `marker` on
      stories/archive, `sort=asc` on post comments when P18 fails, and `offset` on any row whose probe shows OF
      ignores it) are declared and answer `422 unsupported_field` when set (§2.3), never silently dropped.
   3. **Found, not fixed:** the v5 routes `GET transactions` (reference `marker`) and `GET chats/{chat_id}/messages`
      (reference `last_id`) leave the reference cursor undeclared, so a client that builds its own cursor gets
      page 1 again. Declaring them with a 422 turns a 200 into a 422 on a v5 route, which §7 counts as breaking;
      it waits for v3.0.0. Clients that follow `_pagination.next_page` are unaffected. The same holds, after §1.8.1,
      for the declared `offset` on `engagement/messages/mass-messages` and `mass-messaging/overview`: OF ignores it,
      so a client that sets it gets page 1 again; making it a 422 waits for v3.0.0 too.

## 2. Contracts (added to plan-v5 §2; v6 routes only, v5 routes unchanged except §1.8)

### 2.1 Handlers
- Each row's handler calls the `OFClient` method in its table, with the parameters that method takes. Where the
  method cannot take a parameter the row needs, the handler calls `client.request_json("GET", f"{API_BASE}/<the
  method's own path>", params=…)` (precedent: `users/list`, `fans.py:137-139`). This applies to `labels()` (posts
  #3), `schedules_later_chat()` (saved-for-later #1, `offset`) and `tracking_links()` (tracking-links #1).
  `user_highlights()` takes no paging, so stories #4 does not page.
- Captured names (`x:`) and candidates on a new path (`cand:`) use `client.request_json` the same way.
- Waves never edit `of_client.py`, `app.py`, `deps.py`, `tests/conftest.py`, `routes/__init__.py` or
  `routes/shape.py` (plan-v5 §1.10).
- Paths and parameter names are the reference's (yaml). Handlers map them to OF's wire names, following their
  module's existing conventions (`Client` dependency, `ApiError`, `routes.shape.next_page`).
- **Own-account resources** that OF serves on a per-user path use `client.user_id` (`stories/highlights`,
  `settings/social-media-buttons`).
- **Date ranges** use `client.date_range_params(start or None, end or None)` where the reference defaults to a
  window. Where the reference says an empty date means "all" (`chargebacks`), dates are sent only when given.
- **Reshapes.** `data` is OF's response as is, except for these rows:
  1. `GET chats/{chat_id}/messages/{message_id}`: the first item of OF's page if its `id` is `message_id`, else
     `404 not_found`.
  2. `GET fans/{fan_id}/notes`: `{"notes": <user>.notice}`.
  3. `GET saved-for-later/messages/settings` and `…/posts/settings`: the object under the key P10 / P11 recorded, or
     the whole object when P10 / P11 recorded "top".
  4. `GET settings/blocked-countries`: `{"blockedCountries": <settings>.blockedCountries}`.
  5. `GET settings/drm`: `{"enabled": <settings>[<the key P14 recorded>]}`.
  6. `GET settings/welcome-message`: the first item of OF's template list, or `null`.

  `GET mass-messaging/{mass_messaging}` returns OF's queue object as is, not the reference's `{success, queue}`.
  The `{items, hasMore}` adaptor (§2.3) only feeds `next_page`; it does not reshape `data`.

### 2.2 Write bodies (applies §1.2)
- A request model declares every reference field of the row, with `model_config = ConfigDict(extra="forbid")` (the
  v5 `MassMessage` precedent), so keys the reference does not define are a 422 from validation.
- Fields with a verified mapping are sent. Every other declared field raises `422 unsupported_field` only when it
  differs from its no-op default (§1.2). Dropping `saveForLater: true` would publish a post now; dropping
  `scheduledDate` would publish it now too.
- Write parameters that the reference sends in the query follow the same rule.
- Media ids are vault ids (`list[int]`, `min_length=1` where OF would otherwise fake success). The reference's
  upload ids are a 422, because uploads are out (§8).
- An empty update body that `OFClient` would turn into a `ValueError` (`update_profile`) is a 422, never a 500.
- Retrofitting this onto v5 write routes would turn requests they accept today into 422s, which is breaking (§7).

### 2.3 GET parameters and pagination
- The v5 rules apply:
  - query parameters are plain typed values with defaults;
  - reference **filter** parameters OF cannot take: on v6 routes, narrowing ones (search, date window, sort,
    deleted) are declared and answer `422 unsupported_field` when set; cosmetic ones (response size, sync mode,
    `pagination`, `skip_users`) are accepted and ignored. The docstring lists both;
  - `x-next-page` follows the full-page rule via `routes.shape.next_page`.

  An OF page that is not `{list, hasMore}` goes through the v5 adaptor
  (`{"list": page.get("items"), "hasMore": page.get("hasMore")}`), as `engagement/messages/mass-messages` does.
- **The cursor is ours.** `_pagination.next_page` is an opaque absolute URL, so our cursor (usually `offset`) works
  for every client that follows it.
- **A cursor we cannot honour is a 422, never a silent page 1** (§1.8.2). The reference's own cursors (`from_id`,
  `marker`) are declared and answer `422 unsupported_field` when set. A row sends `offset` and emits `x-next-page`
  only when its probe shows that OF's first item at `offset=limit` differs from the one at `offset=0`; otherwise
  the row's Pages is `none`, it emits no `x-next-page`, and `offset` answers 422 when it is above 0. A bare array
  whose probe proves offset paging (P12, P13) is paged through the adaptor `{"list": page, "hasMore": True}`, so the
  full-page rule alone decides; any other page without `list`/`items` and `hasMore` stays `none`. A declared
  parameter with a value we cannot map (`sort=asc` without P18) is the same 422.
- **Limit caps** (`le=`) never exceed what OF honours for that call, so a full page is reachable. Where the cap is
  unknown, it comes from the probe (§3) or defaults to the `OFClient` method's default. On paging routes a larger
  `limit` is clamped to the cap rather than refused, so a full page still yields `x-next-page`.

### 2.4 Routing
- Within a module, literal paths come before parameter paths (plan-v5 §2.2):
  - `posts/labels` before `posts/{post_id}`;
  - `media/vault/lists` above the existing `media/vault/{media_id}`;
  - `stories/archive` and `stories/highlights` before `stories/{story_id}`;
  - `GET chats/{chat_id}/messages/{message_id}` after `…/pinned` and `…/search`;
  - `GET mass-messaging/{mass_messaging}` after `…/overview`.
- The `AfterValidator` trick (`fans.py` `_not_a_list_route`) is only for a **string** slug that shares a prefix with a
  literal reference path. In v6 that is only `users/{username}`. When `users/blocked` and `users/restricted` ship as
  literal routes declared before it, the validator and its test change go. Keep the validator for whichever of the
  two stays `?`. No v6 route adds a new string slug.

### 2.5 Brand and PII
- Code, tests and docstrings say "the reference API". They never spell the reference's id or upload-id prefixes:
  prepublish check 2 rejects the brand outside `docs/spec`.
- Fixtures use 1001-style ids.
- Probe results committed to this plan hold status codes, key names (numeric keys written `<id>`), booleans, counts
  and OF caps only. They never hold ids or values.

## 3. Probe protocol (read-only; the orchestrator runs it once, before cutting `v6/parity`)

**Preconditions (all mandatory).**
- **Where:** the local compose with the proxy on: `GW=http://localhost:4000/v1/<account>`. `<account>` is the
  connected account from the orchestrator brief; it is not written here. `grep -c '^OF_REQUIRE_PROXY=' .env` prints
  `0` (compose's default `true` applies), and `docker compose exec -T upstream printenv OF_REQUIRE_PROXY` prints
  `true` (a shell export overrides `.env`); otherwise stop and ask. Never print any other env value.
- **Key:** a dedicated key named **`v6-probe`** with scope **`read`**, created by the orchestrator through
  `POST /api/keys` (`{"name": "v6-probe", "scope": "read", "allowedAccountIds": [<account>]}`) and saved to
  `/tmp/v6-probe-key.json`. A read key makes the gateway refuse anything but GET (`assertWriteScope`,
  `apps/api/src/modules/proxy/routes.ts:105`). No other key is used for probes.
- **Budget:** at most **50** requests, at least **1 s** apart (`OFClient` itself paces pages 300 ms apart). The sheet
  below uses 49.
- **Stop rule:** any status other than 200, 400 or 404, or a non-JSON body, stops the whole run at once. Every row
  whose probe did not finish stays `?`.
- **Never probed:** `banking/*`, `users/notifications` (a GET there may mark notifications read), and any write.

**Script** (`/tmp/v6-probe.sh`, never committed; run with `bash /tmp/v6-probe.sh 2>&1 | tee /tmp/v6-probe.out`). Ids
are read into shell variables and never echoed; only the probe name, the status, the key shape and booleans are
printed. Probe calls use **double quotes** so the variables expand (`p P04 "users/$C"`), and jq helpers are written
`${items}`.
```bash
#!/bin/bash
set -u
KEY=$(jq -r .secret /tmp/v6-probe-key.json)        # never echoed
GW="http://localhost:4000/v1/$ACCOUNT"            # ACCOUNT from the orchestrator brief
D0=$(date -u -v-30d '+%Y-%m-%d%%2000:00:00'); D1=$(date -u '+%Y-%m-%d%%2023:59:59')
n=0
shape='def k: if test("^[0-9]+$") then "<id>" else . end;
  def t: if type=="array" then {len: length, first: (.[0] | if type=="object" then (keys | map(k)) else type end)}
         else type end;
  if type=="object" then with_entries(.key |= k | .value |= t) else t end'
items='(if type=="array" then . else (.list // .items // []) end)'
p() {  # p <probe> "<OF path?query>": one GET through the passthrough
  n=$((n + 1)); [ "$n" -le 50 ] || { echo "STOP budget"; exit 1; }
  sleep 1
  code=$(curl -sS -o /tmp/p.json -w '%{http_code}' -H "Authorization: Bearer $KEY" "$GW/_of/$2")
  echo "$1 $code"
  case "$code" in 200|400|404) ;; *) echo "STOP $code"; exit 1 ;; esac
  [ -s /tmp/p.json ] && jq empty /tmp/p.json 2>/dev/null || { echo "STOP non-JSON"; exit 1; }
  jq -c "$shape" /tmp/p.json
}
first() { jq -r "$1 // empty" /tmp/p.json; }   # into a variable only: C=$(first '.list[0].withUser.id')
onekey() {  # P10, P11: "top", the one key one level down holding all three, or fail:<count>
  jq -r 'def hit: type=="object" and has("currentCode") and has("isEnabled") and has("options");
    if hit then "top" else ([to_entries[] | select(.value | hit) | .key] | if length == 1 then .[0] else "fail:\(length)" end) end' /tmp/p.json
}
drmkey() {  # P14: the one boolean key whose name contains "drm", or fail:<count>
  jq -r '[to_entries[] | select((.key | test("drm"; "i")) and (.value | type == "boolean")) | .key]
    | if length == 1 then .[0] else "fail:\(length)" end' /tmp/p.json
}
cmpid() { if [ -z "$1" ] || [ -z "$2" ]; then echo inconclusive; elif [ "$1" = "$2" ]; then echo same; else echo different; fi; }
```
Pass checks print booleans with `jq` on `/tmp/p.json` (for example `jq 'has("notice")' /tmp/p.json`), `cmpid`,
`onekey` or `drmkey`. The script prints `n` last (`echo "requests $n"`).

**After the run.**
1. `rm -f /tmp/p.json`.
2. Purge the probe key's request log. The gateway stores every request's path and query in `request_log` (14
   days). `POST /api/keys` answers `{key: {id, …}, secret}` (`contracts.ts:39`), so the id is `.key.id`; `jq -e`
   fails rather than purge `api_key_id='null'`:
   ```bash
   KID=$(jq -er .key.id /tmp/v6-probe-key.json) || exit 1
   q() { docker compose exec -T postgres psql -U gateway gateway -tAc "$1"; }
   q "select count(*) from request_log where api_key_id='$KID'"                                                  # must be >= the run's n
   q "select count(*) from request_log where api_key_id='$KID' and status_code < 400 and resp_body is not null"  # must print 0
   q "delete from request_log where api_key_id='$KID'"
   q "select count(*) from request_log where api_key_id='$KID'"                                                  # must print 0
   ```
   A first count below `n` means the wrong key id: stop and find the right one. A non-zero second count means bodies
   were logged (`LOG_BODIES=all`): delete anyway, and record that in the results.
   The gateway's Fastify request log (`app.ts:36`) and upstream's access log also write every probe URL, chained ids
   included, to the containers' stdout. They stay in the local container logs: never `tee` them, paste them or copy
   them into the transcript or the results.
3. Transcribe into the results table below, then delete `/tmp/v6-probe.out` (the run's `tee` output).
4. Keep the key for the post-merge live check (§6), then revoke it and purge its log rows the same way.

**Outcomes.** An inconclusive probe (the account has no queue entries, stories, comments, or fewer items than the
comparison needs) counts as a fail. A fail makes the row `?`, or (paging) makes the row's Pages `none` (§2.3).

**Sheet** (49 requests). `${items}` is the helper above.

| Probe | Decides | Calls (`p <probe> "…"`, double-quoted; ids read with `X=$(first '…')`) | Pass when | Req |
|---|---|---|---|---|
| P01 | v5 #1 | `chats?limit=2&offset=0&skip_users=all` → `C=.list[0].withUser.id`, `C2=.list[1].withUser.id`; `chats/$C/messages?limit=3&order=desc&skip_users=all` → `M1=.list[0].id`, `MO=.list[-1].id`; the candidate `chats/$C/messages?limit=1&order=desc&skip_users=all&id=$((M1 + 1))`, then the same with `$((MO + 1))`; then `chats/$C2/messages?limit=1&order=desc&skip_users=all&id=$((M1 + 1))` | first item is M1; first item is MO (MO ≠ M1: an older message); in C2 the first item is not M1 (the handler's 404 for a foreign message) | 5 |
| P02 | v5 #2 | `messages/queue?limit=1&offset=0` → `Q=$(first "${items}[0].id")`; `messages/queue/$Q` | 200 and `.id == Q` | 2 |
| P03 | v5 #5, #6 | `lists?limit=50&offset=0&format=infinite`, printing `[.list[] \| select(.type=="blocked" or .type=="restricted") \| {type, word: (.id \| type == "string")}]` and, for an id matching `^[a-z_]+$`, the id itself (a fixed system word, like v5's `fans`); `lists/<blocked id>/users?limit=1&offset=0`; `lists/<restricted id>/users?limit=1&offset=0` | per type: exactly one list, its id is a fixed word, and its users call is `{list, hasMore}`. The handler then calls `list_users_in("<word>")` directly (v5 `ListId` takes words, `fans.py:17-18`). A numeric id fails the row: a per-request `get_lists` lookup costs two OF calls and can miss the list past its first page. | 3 |
| P04 | v5 #7 | `users/$C` | `has("notice")` | 1 |
| P05 | v5 #18 | `payouts/chargebacks/chart?startDate=$D0&endDate=$D1` | chartAmount, chartCount, total and delta all present | 1 |
| P06 | v5 #21 (#20) | `messages/queue/chart?startDate=$D0&endDate=$D1&withTotal=true` | group_messages and group_messages_purchases present. If direct_messages and direct_messages_purchases are also present, v5 #20 ships as L on the same call. | 1 |
| P07 | posts #3 | `labels?limit=1&offset=0` → `L0`; `labels?limit=1&offset=1` → `L1` | `{list, hasMore}` whose item has `postsCount` (post labels, not fan labels). Paging: `cmpid "$L0" "$L1"` = different. | 2 |
| P08 + P19 | media #11, #9 | `vault/lists?view=main&limit=100&offset=0` → `V`, count, `hasMore`; `vault/lists?view=main&limit=1&offset=1` → `V1`; `vault/lists/$V` | #11: 200 and `.id == V`. #9 paging: `cmpid "$V" "$V1"` = different. #9 cap: count 100 → 100; count below 100 with `hasMore` true → count; otherwise (no more folders than the page held) unknown → `vault_lists`' default 10. | 3 |
| P09 + P20 | stories #11, #3 | `stories/archive?limit=1&offset=0` → `S`; `stories/archive?limit=1&offset=1` → `S1`; `stories/$S` | #11: 200 and `.id == S`. #3 paging: `cmpid "$S" "$S1"` = different. | 3 |
| P10 | saved-for-later #2 | `users/settings/chat` | `onekey` prints `top` or a key name: exactly one place holds currentCode, isEnabled and options together (the top level, or one key one level down). Record what it printed. | 1 |
| P11 | saved-for-later #6 | `users/settings/post` | as P10 | 1 |
| P12 + P22 | tracking-links #3, #1 | `campaigns?limit=1&offset=0` → `T`, length; `campaigns?limit=1&offset=1` → `T1`; `campaigns/$T` | #3: 200 and `.id == T`. #1: length 1 and `cmpid "$T" "$T1"` = different → limit and offset sent; else the bare call, Pages none. Record the list key (`list`, `items` or a bare array). | 3 |
| P13 + P22 | trial-links #3, #1 | `trials?limit=1&offset=0` → `T`; `trials?limit=1&offset=1` → `T1`; `trials/$T` | #3: 200 and `.id == T`. #1 paging: `cmpid "$T" "$T1"` = different. Record the list key. | 3 |
| P22 | promotions #1 | `promotions?limit=1&offset=0` → `R`; `promotions?limit=1&offset=1` → `R1` | paging: `cmpid "$R" "$R1"` = different. Record the list key. | 2 |
| P14 | settings #2, #4 | `users/me/settings` | #2: `has("blockedCountries")`. #4: `drmkey` prints a key name (exactly one boolean key whose name contains `drm`, any case); record it. | 1 |
| P15 | v5 #17 | `payouts/chargebacks` → `K0` (gate: no optional parameter); `payouts/chargebacks?limit=1&offset=1` → `K1`; `payouts/chargebacks?startDate=$D0&endDate=$D1` | gate: 200 (400/404 → #17 is `?`). Paging: `cmpid "$K0" "$K1"` = different → limit and offset sent. Dates: 200 → sent; else dropped. | 3 |
| P16 | v5 #19; §1.8.1 | `users/me/stats/messages/direct?startDate=$D0&endDate=$D1` → `G0` (gate); `…/direct?startDate=$D0&endDate=$D1&limit=1&offset=1` → `G1`; the same pair on `users/me/stats/messages/group` | gate: `direct` is 200 with `{hasMore, items}` (400/404 → #19 is `?`). Paging, per endpoint: `cmpid` = different → offset; same → none (and, for `group`, the §1.8.1 fix). | 4 |
| P17 | v5 #22 | `users/me/stats/top/message?startDate=$D0&endDate=$D1` (the range the handler always sends) | 200 (400/404 → #22 is `?`) | 1 |
| P18 | posts #9 | `posts?limit=1&offset=0&order=publish_date_desc&skip_users=all` → own post `P`; `posts/$P/comments?limit=1&offset=0&order=publish_date_desc` → `K0`; the same with `offset=1` → `K1`; the same with `offset=0&order=publish_date_asc` → `KA` | paging: `cmpid "$K0" "$K1"` = different. `sort=asc`: `cmpid "$K0" "$KA"` = different; else asc is a 422. | 4 |
| P21 | saved-for-later #1 | `schedules/later/chat?limit=1&offset=0` → `Z0`; `…&offset=1` → `Z1` | `cmpid "$Z0" "$Z1"` = different → offset sent | 2 |
| P23 | settings #14 | `messages/templates?template=reply_on_subscribe` | `jq "[${items}[] \| .template == \"reply_on_subscribe\"] \| length > 0 and all" /tmp/p.json` is true. Record array vs `{list}`. Fail → #14 is `?`. | 1 |
| P24 | release-forms #6 | `posts/tagged-friend-users?limit=1&offset=0&filter=all&sort=date:desc&skip_users=all` → `U0`; `…&offset=1…` → `U1` | `cmpid "$U0" "$U1"` = different → offset (adaptor) | 2 |

P25 (notification types) is dropped: notifications are never probed.

**Probe results** (filled by the orchestrator: statuses, key names with numeric keys as `<id>`, booleans, counts and
caps only; never ids or values).

| Probe | Statuses | Evidence (keys, booleans, counts) | Decision |
|---|---|---|---|
| P01 | 200 ×5 | `chats` `{list, hasMore, nextOffset}`; messages `{list, hasMore}`, item has `id`. `id=M1+1` → first is M1: same. `id=MO+1` → first is MO: same. MO ≠ M1: different. C2 first ≠ M1: true. | pass: v5 #1 S |
| P02 | 200 ×1 (P02b not sent) | `messages/queue` is a bare array, len 0 | inconclusive (empty queue): v5 #2 `?` |
| P03 | 200 ×1 (P03b, P03c not sent) | `{list, hasMore, order, sort}`, 22 lists; type `blocked`: 0, type `restricted`: 0 | fail: v5 #5, #6 `?`; the `users/{username}` validator stays |
| P04 | 200 | user object; `has("notice")`: false | fail: v5 #7 `?` |
| P05 | 200 | bare array, len 0; chartAmount, chartCount, total, delta: false | fail: v5 #18 `?` |
| P06 | 200 | keys `purchases`, `messages`; group_messages + group_messages_purchases: false; direct_messages + direct_messages_purchases: false | fail: v5 #21 `?`; #20 stays `?` |
| P07 | 200 ×2 | `{list, hasMore, nextOffset, order, sort, hashSort}`; item has `postsCount`: true; offset 0 vs 1: different | pass: posts #3 S, Pages offset |
| P08 + P19 | 200 ×3 | `{list, hasMore, all, canCreateVaultLists, order, sort}`; limit 100 → count 18, hasMore false; offset 0 vs 1: different; `vault/lists/{id}` `.id == V`: true | #11 pass: S. #9 Pages offset; cap unknown (fewer folders than the page) → `vault_lists`' default 10 |
| P09 + P20 | 200 ×3 | archive `{list, hasMore, marker}`; offset 0 vs 1: same; `stories/{id}` `.id == S`: true | #11 pass: S. #3 Pages none (OF ignores offset; it pages by `marker`) |
| P10 | 200 | `{currentCode, isEnabled, options}`; onekey: `top` | pass: saved-for-later #2 S, `data` is the whole object |
| P11 | 200 | `{currentCode, isEnabled, options}`; onekey: `top` | pass: saved-for-later #6 S, `data` is the whole object |
| P12 + P22 | 200, 200, 404 | `campaigns` is a bare array; limit 1 → len 1; offset 0 vs 1: different; `campaigns/{id}`: 404 `{error}` | #3 fail: `?`. #1: bare array → Pages none (§2.3); limit sent, offset 422 above 0; superseded by the implementation review: adaptor paging, §2.3 |
| P13 + P22 | 200, 200, 404 | `trials` is a bare array; limit 1 → len 1; offset 0 vs 1: different; `trials/{id}`: 404 `{error}` | #3 fail: `?`. #1: bare array → Pages none (§2.3); limit sent, offset 422 above 0; superseded by the implementation review: adaptor paging, §2.3 |
| P22 promotions | 200 ×2 | `{hasMore, items}`, limit 1 → len 1; offset 0 vs 1: different | pass: promotions #1 Pages adaptor |
| P14 | 200 | `has("blockedCountries")`: true; drmkey: `isDrmEnabled` | pass: settings #2, #4 S |
| P15 | 200 ×3 | `{list, marker}` on all three; list len 0 (no chargebacks); paging: inconclusive; dates: 200 | gate pass: v5 #17 S; Pages none (P15 paging inconclusive); dates sent |
| P16 | 200 ×4 | `direct` and `group` both `{hasMore, items}`; default page len 10, limit 1 → len 1; offset 0 vs 1: same on both | gate pass: v5 #19 S, Pages none. `group` ignores offset: the §1.8.1 fix applies |
| P17 | 200 | `{purchases}` | gate pass: v5 #22 S |
| P18 | 200 ×4 | `posts` bare array, len 1; comments bare array, len 0 on all three | inconclusive (no comments): posts #9 Pages none, `sort=asc` 422 |
| P21 | 200 ×2 | `{list, hasMore, syncInProcess}`, len 0 | inconclusive (empty): saved-for-later #1 Pages none |
| P23 | 200 | bare array, len 0; check: false | fail: settings #14 `?` |
| P24 | 200 ×2 | `{items, hasMore}`, item has `id`; offset 0 vs 1: different | pass: release-forms #6 Pages adaptor |
| Log purge | psql | first count 46 (= n); bodies on status < 400: 0; bodies on status >= 400: 2 (the two 404s, LOG_BODIES default `errors`); deleted 46; final count 0 | done |

Run 2026-10-04: 46 requests (three follow-up calls not sent because their chained id was empty), no stop. Pre-checks:
`OF_REQUIRE_PROXY` `true` in the upstream container; the `.env` grep was skipped (the container value is the decisive
one); key `v6-probe`, scope `read`.

---

## Legend for the row tables

- **OF call:** `c:` is an `OFClient` method; `x:` is a captured OF endpoint name; `cand:` is an L candidate. Paths are
  relative to `https://onlyfans.com/api2/v2/`.
- **Query / body:** the yaml's key names; `*` marks a required field. "422 when set" is the §1.2 rule.
- **Pages:**
  - `offset`: the full-page rule;
  - `adaptor`: the `{items, hasMore}` adaptor;
  - `none`: a single object or array; no `x-next-page`.
  - "(Pnn)": `offset`/`adaptor` if Pnn's paging check passes, else `none` with `offset` a 422 above 0 (§2.3).
- **St:** the status from §1.1.
- Only rows that ship or are probe-gated have a table row. Each group's `?`, `?ref`, *have* and out rows follow as
  one list.

## Rows

### v5 open rows (`chats.py`, `fans.py`, `money.py`)

Numbering is the v5 order: #1–#26 were `?`, #27–#36 were `deferred-write`.

| # | M | Tail | Module | OF call (source) | Query / body | Pages | St |
|---|---|---|---|---|---|---|---|
| 1 | GET | `chats/{chat_id}/messages/{message_id}` | chats | cand: c:`get_messages(chat_id, limit=1, order="desc", before_id=message_id + 1)` (OF's `id` is an older-than bound, `of_client.py:461-463`). Reshape §2.1 #1. P01 passed. | — | none | S |
| 2 | GET | `mass-messaging/{mass_messaging}` | chats | cand: `messages/queue/{id}`, the resource c:`cancel_scheduled` deletes. OF's object as is. P02 inconclusive. | — | none | `?` |
| 5 | GET | `users/blocked` | fans | cand: c:`list_users_in("<word>")`, the word P03 recorded. Declared before `users/{username}`. | q limit (≤20), offset; query dropped | offset (v5's `user-lists/{id}/users` call) | `?` (P03) |
| 6 | GET | `users/restricted` | fans | as #5, the restricted list. P03. | as #5 | as #5 | `?` (P03) |
| 7 | GET | `fans/{fan_id}/notes` | fans | cand: c:`get_user(fan_id)` → `{"notes": <notice>}` (§2.1 #2). **Assumption:** `notice` on `users/{id}` is the note c:`set_fan_note` writes on `subscriptions/{id}`; `of_client.py:1873-1876` calls fan notes a third-party feature. P04 only shows the key exists. | — | none | `?` (P04) |
| 17 | GET | `chargebacks` | money | x:`payouts/chargebacks` | q start_date, end_date (empty = all; sent, P15); limit 422 when set (OF page size unverified); offset | none (P15) | S (P15) |
| 18 | GET | `chargebacks/statistics` | money | cand: x:`payouts/chargebacks/chart`. P05. | q start_date, end_date | none | `?` (P05) |
| 19 | GET | `engagement/messages/direct-messages` | money | x:`users/me/stats/messages/direct`, the direct twin of v5's `…/group` call | q startDate*, endDate*, limit, offset; query 422 when set | none (P16) | S (P16) |
| 21 | GET | `engagement/messages/mass-messages/chart` | money | cand: x:`messages/queue/chart`. P06. | q startDate, endDate, withTotal | none | `?` (P06) |
| 22 | GET | `engagement/messages/top-message` | money | x:`users/me/stats/top/message` | q startDate, endDate | none | S (P17) |
| 32 | DELETE | `fans/{fan_id}/notes` | fans | c:`set_fan_note(fan_id, "")` → `PUT subscriptions/{fan_id} {"notice": ""}` (VERIFIED LIVE; an empty string clears) | — | — | S |

- `?` (23 rows, 24 ops): #3 `GET me/top-percentage`; #8 `GET fans/{user_id}/subscriptions-history`; #9
  `GET user-lists/{userListId}/users/pinned`; #10–16 `GET banking/available-payout-systems`, `banking/countries`,
  `banking/details/account-country`, `…/bank`, `…/dac7-form`, `…/legal-form`, `…/legal-info` (never probed, §9 Q2);
  #20 `GET engagement/messages/direct-messages/chart` (P06 did not promote it); #23
  `GET engagement/messages/{message_id}/buyers`; #24 `GET statistics/subscriber-metrics` (computed by the reference);
  #25 `GET statistics/total-transactions` (no data shape in the yaml); #27 `DELETE chats/{chat_id}`; #28
  `POST chats/{chat_id}/typing`; #29 `POST messages/{queue_id}/attach-tags`; #30 `PUT, PATCH
  mass-messaging/{mass_messaging}` (2 ops; OF's queue has no sourced update); #31 `PUT queue/{queue_id}/publish`;
  #33 `DELETE user-lists/{userListId}/users` (no body or query documented); #34
  `POST user-lists/{userListId}/users/{userId}/pin`; #35 `PATCH payouts/payout-frequency` (§9 Q6); #36
  `POST payouts/request-manual-withdrawal` (§9 Q6).
- `?ref` (2): #4 `GET session`; #26 `GET workflows/account-performance/starting-revenues`.
- **Totals:** 36 rows (37 ops): S 1, S·gate 3, L 7, `?` 25 rows (26 ops), 2 of them *ref*.
- **After §3:** S 5 (#1, #17, #19, #22, #32), `?` 31 rows (32 ops): the list above plus #2, #5, #6, #7, #18, #21.

### content (`content.py`)

**posts (18)**

| # | M | Tail | OF call (source) | Query / body | Pages | St |
|---|---|---|---|---|---|---|
| 2 | POST | `posts` | c:`create_post` → `POST posts`. The CONFIRMED live post (`of_client.py:1920-1925`) carried text, mediaFiles, price and preview. | body text*, mediaFiles (vault ids). 422 when set (no-op check on the raw JSON value): previews (`preview` is confirmed on paid posts only), scheduledDate, expireDays, fundRaisingTargetAmount, fundRaisingTipsPresets, labelIds, rfTag, saveForLater, votingType, votingOptions, votingDue, votingCorrectIndex, blockBannedWords. The yaml has no price, so posts are free (`price` 0). | — | S |
| 3 | GET | `posts/labels` | cand: c:`labels` → `labels` (its docstring says fan labels; P07 checks they are post labels). `request_json` with limit and offset when P07's paging passes, else bare `labels()`. | q limit, offset | offset (P07) | S (P07) |
| 7 | DELETE | `posts/{post_id}` | c:`delete_post` (body-less, §1.2) | — | — | S |
| 9 | GET | `posts/{post_id}/comments` | c:`post_comments` → `posts/{id}/comments` | q limit, offset, sort (desc → `publish_date_desc`; asc → `publish_date_asc` if P18 passes, else 422) | none (P18) | S |

- `?` (12 rows, 13 ops): #4 `POST posts/labels`; #6 `PUT, PATCH posts/{post_id}` (2 ops; c:`edit_post`'s `PUT` effect
  is unverified, §1.2); #8 `POST posts/{post_id}/archive`; #10 `POST posts/{post_id}/comments` (c:`comment_on_post`'s
  body is not marked verified); #11 `DELETE …/comments/{comment_id}`; #12, #13 `POST, DELETE
  …/comments/{comment_id}/like`; #14, #15 `POST, DELETE …/comments/{comment_id}/pin`; #16 `POST posts/{post_id}/pin`
  (c:`pin_post`: toggle or set is unverified, §1.2); #17 `GET posts/{post_id}/stats` (x:`posts/chart` and `posts/top`
  are account-wide); #18 `POST posts/{post_id}/unarchive`.
- *have* (2): #1 `GET posts` (c:`list_posts`), #5 `GET posts/{post_id}` (c:`get_post`).

**media (16)**

| # | M | Tail | OF call (source) | Query / body | Pages | St |
|---|---|---|---|---|---|---|
| 9 | GET | `media/vault/lists` | c:`vault_lists(view="main", limit, offset)` | q limit (clamped to 10, P19's cap), offset; query 422 when set; lightweight dropped | offset (P19) | S |
| 10 | POST | `media/vault/lists` | c:`create_vault_list` (CONFIRMED, `of_client.py:940-944`) | body name* | — | S |
| 11 | GET | `media/vault/lists/{list_id}` | cand: `vault/lists/{id}`, the resource c:`rename_vault_list` and c:`delete_vault_list` write. P08. | — | none | S (P08) |
| 12 | PUT, PATCH | `media/vault/lists/{list_id}` | c:`rename_vault_list` → `PATCH vault/lists/{id}` (CONFIRMED, `:955-961`) | body name* | — | S (2 ops) |
| 13 | DELETE | `media/vault/lists/{list_id}` | c:`delete_vault_list(clear_media=False)`: the media stay in the vault (CONFIRMED, `:963-970`) | — | — | S |
| 14 | POST | `media/vault/lists/{list_id}/media` | c:`add_media_to_vault_list` (CONFIRMED, `:946-953`) | body mediaIds* (min 1) | — | S |

- `?` (2): #8 `DELETE media/vault/delete-media` (c:`hide_vault_media`'s body was read from OF's web bundle, not
  marked VERIFIED or CONFIRMED live; it is also one-way, §9 Q4); #15 `DELETE media/vault/lists/{list_id}/media` (no
  sourced call removes media from a folder).
- *have* (2): #6 `GET media/vault`, #16 `GET media/vault/{media_id}`.
- out (6, §8): #1 `GET media/download/drm/{media_id}`, #2 `GET media/download/{cdnUrl}`, #3 `POST media/scrape`, #4
  `POST media/upload`, #5 `GET media/uploads/{upload}/status`, #7 `POST media/vault`.

**stories (15)**

| # | M | Tail | OF call (source) | Query / body | Pages | St |
|---|---|---|---|---|---|---|
| 1 | GET | `stories` | c:`my_stories` → `users/me/stories` | — | none | S |
| 3 | GET | `stories/archive` | c:`my_stories_archive(limit, offset)` → `stories/archive` | q limit; marker 422 when set (§2.3) | none (P20) | S |
| 4 | GET | `stories/highlights` | c:`user_highlights(client.user_id)` → `users/{me}/stories/highlights` (the method takes no paging) | q limit dropped; offset 422 above 0 | none | S |
| 11 | GET | `stories/{story_id}` | cand: `stories/{id}`, the resource c:`delete_story` deletes. P09. | — | none | S (P09) |
| 12 | DELETE | `stories/{story_id}` | c:`delete_story` (body-less, §1.2) | — | — | S |

- `?` (10 rows, 11 ops): #2 `POST stories`; #5 `POST stories/highlights`; #6 `GET stories/highlights/{highlight_id}`;
  #7 `PUT, PATCH stories/highlights/{highlight_id}` (2 ops); #8 `DELETE stories/highlights/{highlight_id}`; #9, #10
  `PATCH, DELETE stories/highlights/{highlight_id}/{story_id}`; #13 `POST stories/{story_id}/mark-as-watched`; #14
  `GET stories/{story_id}/stats` (x:`stories/chart` and `stories/top` are account-wide); #15
  `GET stories/{story_id}/viewers`.

**saved-for-later (8)**

| # | M | Tail | OF call (source) | Query / body | Pages | St |
|---|---|---|---|---|---|---|
| 1 | GET | `saved-for-later/messages` | c:`schedules_later_chat(limit=…)` → `schedules/later/chat`; with P21 passing, `request_json` on the same path with limit and offset | q limit, offset | none (P21) | S |
| 2 | GET | `saved-for-later/messages/settings` | cand: c:`settings_chat` (`users/settings/chat`), reshaped (§2.1 #3). P10. | — | none | S (P10) |
| 5 | GET | `saved-for-later/posts` | c:`schedules_later_post(limit, offset)` → `schedules/later/post` (its docstring: offset pages) | q limit, offset | offset | S |
| 6 | GET | `saved-for-later/posts/settings` | cand: c:`settings_post` (`users/settings/post`), reshaped (§2.1 #3). P11. | — | none | S (P11) |

- `?` (4): #3 `PATCH …/messages/settings/disable-automatic-messaging`; #4 `PATCH
  …/messages/settings/enable-or-update-automatic-messaging`; #7 `PATCH …/posts/settings/disable-automatic-posting`; #8
  `PATCH …/posts/settings/enable-or-update-automatic-posting`.
- **Content totals:** 57 rows (60 ops): *have* 4, S 14 rows (15 ops), L 5, `?` 28 rows (30 ops), out 6.
- **After §3:** all five L rows passed: S 19 rows (20 ops), L 0.

### promo (`promo.py`)

| Group | # | M | Tail | OF call (source) | Query / body | Pages | St |
|---|---|---|---|---|---|---|---|
| tracking-links | 1 | GET | `tracking-links` | c:`tracking_links()` → `campaigns` (also x:`campaigns`); with P22 passing, `request_json` on `campaigns` with limit and offset | q limit, offset; startDate, endDate, with_deleted, sortby, sort 422 when set; pagination, synchronous dropped | adaptor (bare array; P12 offset passed) | S |
| tracking-links | 2 | POST | `tracking-links` | c:`create_tracking_link(name=…)` → `POST campaigns {name}` (VERIFIED LIVE, `of_client.py:1807-1817`) | body name*; tags 422 when set | — | S |
| tracking-links | 3 | GET | `tracking-links/{tracking_link_id}` | cand: `campaigns/{id}`, the resource c:`delete_tracking_link` deletes. P12. | — | none | `?` (P12) |
| tracking-links | 4 | DELETE | `tracking-links/{tracking_link_id}` | c:`delete_tracking_link` (body-less) | — | — | S |
| trial-links | 1 | GET | `trial-links` | c:`trial_links(offset, limit)` → `trials` (limit verified live) | q limit (≤ 100), offset; startDate, endDate, sort, field 422 when set; synchronous dropped | adaptor (bare array; P13 offset passed) | S |
| trial-links | 3 | GET | `trial-links/{trial_link_id}` | cand: `trials/{id}`, the resource c:`delete_trial_link` deletes. P13. | — | none | `?` (P13) |
| trial-links | 4 | DELETE | `trial-links/{trial_link_id}` | c:`delete_trial_link` (body-less) | — | — | S |
| promotions | 1 | GET | `promotions` | c:`promotions(offset, limit)` → `promotions` (hasMore unreliable: full-page rule) | q limit, offset | adaptor (P22: `{hasMore, items}`) | S |
| promotions | 3 | DELETE | `promotions/{promotion_id}` | c:`delete_promo` (body-less) | — | — | S |
| bundles | 5 | GET | `bundles` | c:`subscription_bundles` → `subscriptions/bundles` | — | none | S |
| bundles | 7 | DELETE | `bundles/{bundle_id}` | c:`delete_bundle` (body-less) | — | — | `?` (Q6: changes pricing) |

- `?` (12): tracking-links #7 `GET …/{id}/stats` (x:`campaigns/chart` exists; whether it takes a link id is
  unknown), #8 `GET …/{id}/subscribers`; trial-links #2 `POST trial-links` (c:`create_trial_link`'s body is not
  marked verified), #7 `GET …/{id}/stats` (x:`trials/stats` and `trials/chart` exist; the per-link parameter is
  unknown), #8 `GET …/{id}/subscribers`; `GET shared-tracking-links`, `DELETE
  shared-tracking-links/{shared_tracking_link_id}`, `GET shared-trial-links`, `DELETE
  shared-trial-links/{shared_trial_link_id}`; promotions #2 `POST promotions` (the reference's `type`,
  `expirationDays` and `freeTrialDays` have no verified OF field), #4 `POST promotions/{promotion_id}/stop`; bundles #6
  `POST bundles` (c:`create_bundle`'s body is unverified, and the reference's query `discount`, `duration` does not map
  onto `months`, `price`).
- `?ref` (20): tracking-links #5 `cohort-arps`, #6 `spenders`, #9–11 `GET, POST, DELETE …/tags`; the same five on
  trial-links; `GET, POST, DELETE shared-tracking-links/{id}/tags` and `shared-trial-links/{id}/tags` (6);
  `GET stored/shared-tracking-links`, `stored/shared-trial-links`, `stored/tracking-links`, `stored/trial-links` (4).
- **Promo totals:** 43 rows (43 ops): S 9, L 2, `?` 32, 20 of them *ref*.
- **After §3:** tracking-links #3 and trial-links #3 failed: S 9, L 0, `?` 34, 20 of them *ref*.
- **After the implementation review:** bundles #7 moved to `?` under §9 Q6: S 8, `?` 35, 20 of them *ref*.

### settings (`settings.py`)

| Group | # | M | Tail | OF call (source) | Query / body | Pages | St |
|---|---|---|---|---|---|---|---|
| settings | 1 | GET | `settings` | c:`my_settings` → `users/me/settings` | — | none | S |
| settings | 2 | GET | `settings/blocked-countries` | cand: the key `blockedCountries` of `users/me/settings` (§2.1 #4). P14. | — | none | S (P14) |
| settings | 4 | GET | `settings/drm` | cand: the DRM boolean P14 names in `users/me/settings` (§2.1 #5). P14. | — | none | S (P14) |
| settings | 6 | POST | `settings/profile` | c:`update_profile(about=…)` → `PATCH users/me` (`about` verified live, `of_client.py:1861-1867`) | body about; name, location, website, wishlist ("likely" in the docstring), username, avatar, header: 422 when set; no `about` → 422 | — | S |
| settings | 7 | GET | `settings/social-media-buttons` | c:`user_social_buttons(client.user_id)` → `users/{me}/social/buttons` (also x:) | — | none | S |
| settings | 14 | GET | `settings/welcome-message` | c:`message_templates(template="reply_on_subscribe")` (§2.1 #6) | — | none | `?` (P23) |
| release-forms | 6 | GET | `release-forms/taggable-users` | c:`tagged_friend_users` → `posts/tagged-friend-users` (captured live; the post and chat tag picker) | q limit, offset, name (→ OF `name` search); filter `all`, sort `date`, sortDirection `desc` (the captured call; other values 422) | adaptor (P24 passed) | S |
| notifications | 8 | GET | `notifications` | c:`notifications(limit, type)` → `users/notifications` | q limit, type: all → none, subscriptions → subscribed, tips → tipped, comments → commented, mentions → mentioned (verified live in the client); other values `422 unsupported_type`. skip_users dropped; from_id 422 when set. | none (never probed, §3) | `?` (may mark read; never probed) |
| notifications | 9 | GET | `notifications/counts` | c:`notifications_count` → `users/notifications/count` | — | none | S |
| notifications | 12 | GET | `notifications/tabs-order` | c:`notification_tabs_order` | — | none | S |

- `?` (19 rows, 20 ops): settings #3 `PUT settings/blocked-countries`; #5 `PATCH settings/drm`; #8
  `POST settings/social-media-buttons`; #9 `POST …/social-media-buttons/reorder`; #10 `PUT, PATCH
  …/social-media-buttons/{button_id}` (2 ops); #11 `DELETE …/social-media-buttons/{button_id}`; #12
  `PATCH settings/subscription-price` (§9 Q6); #13 `POST settings/username-exists` (the yaml does not say what the
  reference's `success` means); #15 `POST settings/welcome-message` (c:`upsert_welcome_template`'s body "mirrors the
  live OF web client" but is not marked VERIFIED or CONFIRMED); #16 `PATCH settings/welcome-message`
  (c:`set_reply_on_subscribe`, not marked verified; §1.7); release-forms #1 `GET release-forms`, #2
  `POST …/create-invitation-link`, #3 `POST …/create-release-form`, #4 `GET …/mentions`, #5 `PATCH …/rename`, #7
  `PATCH …/toggle-show`; notifications #10 `POST notifications/mark-all-as-read`, #11 `GET notifications/search-users`
  (c:`search_users` is the global user search, not this), #13 `PUT notifications/tabs-order`.
- **Settings totals:** 29 rows (30 ops): S 7, S·gate 1, L 2, `?` 19 rows (20 ops).
- **After §3:** settings #2 and #4 passed, #14 failed: S 9, S·gate 0, L 0, `?` 20 rows (21 ops).
- **After the implementation review:** notifications #8 moved to `?` (OF's list call may mark notifications read,
  and it was never probed): S 8, `?` 21 rows (22 ops).

### Wave acceptance
- Every S row and every passing probe-gated row is served; every failed one is `?` and listed in the inventory's
  "v6 execution notes". `tests/test_routes_{chats,fans,money,content,promo,settings}.py` get one `of_fake` test per
  route, asserting the OF method, the URL, the JSON body, the `data` value and `x-next-page`.
- Literal-before-parameter order (§2.4) holds: tests show `GET media/vault/lists`, `GET stories/archive`,
  `GET stories/highlights` and `GET posts/labels` reach their own routes, not a 422 from the integer route; the
  `{message_id}` and `{mass_messaging}` GETs do not shadow `pinned`, `search` or `overview`.
- `test_routes_fans.py`'s "users/blocked is not a username" case changes to the served route for each list route
  that ships.
- Each 422 group has a test: a non-default value is a 422, the default value is accepted (§1.2).
- `settings/profile` returns a 422 for an empty body and for `username`, `avatar` and `header`; unmapped notification
  types give a 422.
- The §1.8.1 fix, if P16 shows `group` ignores offset: tests show `engagement/messages/mass-messages` and
  `mass-messaging/overview` set no `x-next-page` on a full page.
- The content module docstring drops "the rest of the group is plan-v6".
- `check --have` gains exactly the new operations.

## 4. Totals and parity baseline

| Group | Rows (ops) | have | S rows (ops) | S·gate | L | `?` rows (ops) | of which *ref* | out |
|---|---|---|---|---|---|---|---|---|
| v5 open rows | 36 (37) | 0 | 1 (1) | 3 | 7 | 25 (26) | 2 | 0 |
| content | 57 (60) | 4 | 14 (15) | 0 | 5 | 28 (30) | 0 | 6 |
| promo | 43 (43) | 0 | 9 (9) | 0 | 2 | 32 (32) | 20 | 0 |
| settings | 29 (30) | 0 | 7 (7) | 1 | 2 | 19 (20) | 0 | 0 |
| **Total** | **165 (170)** | **4** | **31 (32)** | **4** | **16** | **104 (108)** | **22** | **6** |

**After the §3 probes (2026-10-04):** 11 probe-gated operations pass (v5 #1, #17, #19, #22; posts #3, media #11,
stories #11, saved-for-later #2, #6; settings #2, #4); 9 fail (v5 #2, #5, #6, #7, #18, #21; tracking-links #3,
trial-links #3; settings #14), and P06 does not promote v5 #20.

| Group | Rows (ops) | have | S rows (ops) | S·gate | L | `?` rows (ops) | of which *ref* | out |
|---|---|---|---|---|---|---|---|---|
| v5 open rows | 36 (37) | 0 | 5 (5) | 0 | 0 | 31 (32) | 2 | 0 |
| content | 57 (60) | 4 | 19 (20) | 0 | 0 | 28 (30) | 0 | 6 |
| promo | 43 (43) | 0 | 9 (9) | 0 | 0 | 34 (34) | 20 | 0 |
| settings | 29 (30) | 0 | 9 (9) | 0 | 0 | 20 (21) | 0 | 0 |
| **Total** | **165 (170)** | **4** | **42 (43)** | **0** | **0** | **113 (117)** | **22** | **6** |

**After the implementation review:** `DELETE bundles/{bundle_id}` (§9 Q6) and `GET notifications` (never probed)
moved to `?`: promo S 8 (8), `?` 35 (35); settings S 8 (8), `?` 21 (22); **total S 40 (41), `?` 115 (119)**.

- **Ship now:** 32 operations (31 rows). **Probe-gated:** 20 operations (16 L + 4 S·gate), plus v5 #20 if P06
  promotes it.
- **Writes that ship:** 14 operations (13 rows), all part of the 32: `DELETE fans/{fan_id}/notes`, `POST posts`,
  `DELETE posts/{post_id}`, `POST media/vault/lists`, `PUT` and `PATCH media/vault/lists/{list_id}`,
  `DELETE media/vault/lists/{list_id}`, `POST media/vault/lists/{list_id}/media`, `DELETE stories/{story_id}`,
  `POST tracking-links`, `DELETE tracking-links/{id}`, `DELETE trial-links/{id}`, `DELETE promotions/{id}`,
  `POST settings/profile` (`DELETE bundles/{id}` moved to `?` in the implementation review). Only `POST posts`, `POST tracking-links` (`tags`) and
  `POST settings/profile` carry 422 fields.

| `baseline.txt` | every gate fails | every gate passes |
|---|---|---|
| today | 73 | 73 |
| after `v6/parity` | **105** | **125** (126 if P06 promotes v5 #20) |
| after `v6/parity`, per the §3 results | **116** | **116** |
| after the `v6/parity` review fixes | **114** | **114** |

Of 239 in-scope operations, 114–134 stay missing after v6 (113 with v5 #20): the 108 `?` operations, the 6 out
rows and any failed probe-gated row. Per the §3 results: **123** (117 `?` + 6 out); after the review fixes: **125** (119 `?` + 6 out).

Actual after merge 6fb4a94: 41 operations, baseline 114.

## 5. Env additions

None. No migration, no env var, no gateway code. `.env.example` is unchanged.

## 6. Workstream, merge and gates

| Step | Branch | Owns |
|---|---|---|
| 0 | master (orchestrator) | The `v6-probe` key, the probe run and its results table (§3). Seam commit: `routes/promo.py` and `routes/settings.py`, each just `router = APIRouter(prefix="/of", tags=["of-api"])`, added to `ROUTERS`. |
| 1 | `v6/parity` (worktree `.claude/worktrees/v6-parity`) | `routes/{chats,fans,money,content,promo,settings}.py`, `tests/test_routes_{chats,fans,money,content,promo,settings}.py` |

- **One implementer (opus, high), then a reviewer → fix loop, before the merge.** The implementer starts only after
  the results table is filled; it never probes. Commit on the branch or master; **never push**.
- **Single-writer files:**
  - **The orchestrator alone** owns the seam commit, `docs/spec/parity/baseline.txt`, this plan's probe results,
    the inventory's "v6 execution notes", `CHANGELOG.md` and the release commit's version bumps.
  - **The wave never edits** `of_client.py`, `app.py`, `deps.py`, `tests/conftest.py`, `routes/__init__.py`,
    `routes/shape.py`, gateway code or `reference-routes.txt`.
  - If the wave needs one of these files, it stops and reports.
- **Gates before the merge.** Run them on the rebased branch. If the worktree lacks `node_modules`, run them on
  master after the merge.
  1. `pnpm -r typecheck`; `pnpm --filter @gateway/api test`; `pnpm --filter @gateway/web test`.
  2. `cd services/upstream && UPSTREAM_TOKEN=test-token-at-least-16-chars UPSTREAM_STATE_DIR=$(mktemp -d) ~/.cache/gateway-upstream-venv/bin/python -m pytest -q`
     and `~/.cache/gateway-upstream-venv/bin/ruff check .`
  3. No drizzle drift: `pnpm --filter @gateway/api db:generate` produces no new file.
  4. `pnpm prepublish-check` fails **only** on check 2b.
  5. Parity: dump the spec (below), then `node scripts/parity-audit.mjs check /tmp/up.json` exits 0 (no lost
     operation, no off-spec route). `check /tmp/up.json --have` lists every S operation and every probe-gated
     operation whose probe passed.
  6. Grep the diff (`git diff master...` outside `docs/spec`) for `@`, the pattern list from the orchestrator brief (not written here) and any proxy
     host: zero hits.
     - `@` also matches every Python decorator and pytest mark. The reviewer confirms each `@` hit is one of those,
       or uses the email-shaped form:
       `git diff master... -- . ':!docs/spec' | sed -n 's/^+//p' | grep -nE '[A-Za-z0-9._%-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}'`.
  7. On macOS, in-place edits use `sed -i ''`.
- **After the merge** (orchestrator, as its own commit `chore(parity): baseline after v6/parity`). The plain `check`
  runs first, against the old baseline, so a lost operation fails before anything is written; the new baseline goes
  to `/tmp` and replaces the tracked file only when both runs exit 0 (redirecting straight into `baseline.txt`
  would empty it before `node` reads it, and leave it written on a failure):
  ```sh
  cd services/upstream && UPSTREAM_TOKEN=test-token-at-least-16-chars UPSTREAM_STATE_DIR=$(mktemp -d) \
    ~/.cache/gateway-upstream-venv/bin/python -c 'import json, app; print(json.dumps(app.app.openapi()))' > /tmp/up.json
  cd ../.. && node scripts/parity-audit.mjs check /tmp/up.json \
    && node scripts/parity-audit.mjs check /tmp/up.json --have > /tmp/baseline.txt \
    && mv /tmp/baseline.txt docs/spec/parity/baseline.txt
  ```
  v6 never runs `parity-audit.mjs extract`: it reads a mirror page and rewrites `reference-routes.txt`, so it cannot
  produce the baseline.
- **Live check after the merge** (orchestrator, read-only, with the `v6-probe` key): every newly shipped GET through
  `/v1/<account>/<tail>` (`notifications` is not shipped, §3). It includes `stories/highlights`, whose single answer
  is unprobed: record whether it carries `hasMore`. Also count `tracking-links?limit=100` (`campaigns`; its cap of
  100 is unverified): fewer than 100 with more links on the account means OF caps lower. It reuses the §3 script with `p` pointed at `$GW/<tail>`
  instead of `$GW/_of/…`: at most 50 requests at least 1 s apart, the same stop rule, double-quoted calls, and ids for
  `{…}` tails chained from a list GET into shell variables (now under `.data`) and never echoed. Record the status,
  the wrapper keys (`data`, `_meta`, `_pagination`) and `data`'s top-level keys only. Then revoke the key and purge
  its log rows exactly as in §3 (pre-delete count ≥ `n`).

## 7. Tests and release

- **Tests** follow plan-v5 §7: `of_fake` at `_http_call`, one test per route asserting:
  - the OF method, URL and JSON body;
  - the `data` value;
  - `x-next-page`: set on a full page with `hasMore`, not set on a short or empty page, never set on a `none` row.

  On top of that:
  - one OF 4xx pass-through test per module;
  - a 422 test for each group of unsupported fields or cursors, plus one showing the no-op default is accepted;
  - a literal-before-parameter test wherever §2.4 applies;
  - each §2.1 reshape tested on its output (welcome-message for a present and an absent template).

  Ids are 1001-style. `client.user_id` is `"1001"` in `of_fake`.
- **Release v2.1.0** (orchestrator, after the merge and the live check, as its own commit; the owner tags it):
  - **Additive.** v6 adds named routes only. It changes nothing in:
    - the wrapper and `_pagination`;
    - the webhook envelope, signature or event names, and the upstream frames;
    - the passthrough, the database schema or the env.

    The gateway and upstream images do not have to be upgraded together: a 2.0 gateway forwards the new routes
    through its catch-all.
  - **Existing paths whose answer changes:** every new route turns a 404, 405 or 422 into a success. The §1.8.1 fix
    removes a looping `x-next-page` from two v5 routes; a client that followed it now stops after page 1 instead of
    re-reading it. None of this is breaking.
  - **Would be breaking, and is not done in v6:**
    - retrofitting the §2.2 422 rule onto v5 write routes;
    - declaring a v5 route's missing cursor with a 422 (§1.8.3);
    - changing a v5 route's query names or `data` shape;
    - renaming any tail.

    If any of these is wanted later, release it as **v3.0.0** with an "Upgrading to 3.0" section.
  - **Versions:** bump `package.json`, `apps/api/package.json`, the swagger `info.version` in
    `apps/api/src/app.ts:56` and `services/upstream/app.py:77` to `2.1.0` in the release commit (the one
    orchestrator edit to `app.py`).
  - **`CHANGELOG.md`:** add `## [2.1.0] - <date>` with:
    - *Added*: the S routes per group, with counts;
    - *Added (verified on one account)*: the probe-gated routes that passed, listed separately: a read-only probe on
      one connected account is their only evidence;
    - *Fixed*: the §1.8.1 `x-next-page` loop, if P16 confirmed it;
    - *Notes*: the 422 fields on `POST posts`, `POST tracking-links` and `POST settings/profile` and why (§1.2);
      every `?` row stays reachable through `_of/` when OF has the call.

    Also date the `## [2.0.0]` heading **2026-10-02**, the date of the commit tag v2.0.0 points at (bc2220b).

## 8. Not in v6

- **Media transfer (6 rows):**
  - `POST media/upload`, `GET media/uploads/{upload}/status`, `POST media/vault` and `POST media/scrape` are uploads.
    The gateway takes JSON bodies up to 1 MiB, the passthrough is JSON-only and buffered, v4 deleted the multipart S3
    flow, and an upload pipeline also means emitting `media_uploads.*`.
  - `GET media/download/{cdnUrl}` is a binary download. Responses are buffered whole, not streamed (plan-v5 §2.1), so
    large media would sit in gateway memory.
  - `GET media/download/drm/{media_id}` serves DRM-protected media. We do not build DRM circumvention, now or later.
  - Upload-id values are a 422: in `mediaFiles` on posts (vault ids are accepted), and in `avatar` and `header` on
    settings/profile.
- **`media_uploads.*` events** stay *never*.
- **The reference's own features** (22 `?ref` rows): link tags, stored and shared-link copies, the session record,
  workflow revenues, cohort ARPS and spenders. They need gateway-side storage or jobs, not an OF call (§9 Q3).
- **Owner captures for the other 72 `?` rows** (104 `?` rows minus 22 *ref*, the 7 `banking/*` rows of §9 Q2 and the 3
  money writes of §9 Q6; §9 Q1). Without them those rows stay passthrough-only, and a v6.x wave picks them up later.
- **Retrofits to v5 routes** beyond §1.8 (§7).
- **New `OFClient` methods.** Captured names and candidates go through `request_json`.
- **Everything plan-v5 §8 cuts:** team-level rows, `analytics/*`, `_meta` contents, key `permission_level` and
  `account_scope`, poll-derived events, passthrough and audit extras.
- **FUTURE.md items:** the user-designable statistics page, the one-command Hostinger deploy, and supplying the
  upstream as a separate service (`docs/spec/handoff-of-serving.md`).

## 9. Owner questions (default answers apply until you say otherwise)

1. **Captures for the `?` rows.** 72 `?` rows (excluding the 22 *ref* rows, the 7 `banking/*` rows and the 3 money
   writes of Q6) need OF's method, path and body key names from a devtools capture of the action on onlyfans.com.
   *Default: no capture in v6; the rows stay passthrough-only. If you capture, record the method, the path and the
   body key names only (no values), and a v6.x wave ships them. Suggested order:*
   - *the writes whose path is sourced but whose body or effect is not (Q4);*
   - *post archive, unarchive and stats;*
   - *story viewers and stats, and highlight CRUD;*
   - *comment like, pin and delete;*
   - *removing media from a vault folder;*
   - *the mass-messaging update, and chat delete.*
2. **`banking/*` (7 rows).** *Default: stay `?` and are never probed (bank, tax and identity data). Moving `banking/`
   into `OUT_OF_SCOPE` can wait for a later plan.*
3. **The reference's own features (22 rows).** *Default: not built. The rows stay missing in the audit and are not
   moved to `OUT_OF_SCOPE`, so the count stays honest.*
4. **Unverified write bodies and effects.** These rows have a sourced OF path but stay `?` under §1.2:
   `PUT, PATCH posts/{post_id}` (`edit_post`), `POST posts/{post_id}/comments` (`comment_on_post`),
   `POST posts/{post_id}/pin` (`pin_post`), `DELETE media/vault/delete-media` (`hide_vault_media`, one-way),
   `POST trial-links` (`create_trial_link`), `POST promotions` (`create_promo`), `POST bundles` (`create_bundle`),
   `POST` and `PATCH settings/welcome-message` (`upsert_welcome_template`, `set_reply_on_subscribe`). These fields
   are declared and answer 422 when set: on `POST posts`, `scheduledDate` (→ `postedAt`?), `expireDays`
   (→ `expirePeriod`?), `fundRaisingTargetAmount` (→ `fundRaisingTarget`?) and the rest of its list; on
   `POST settings/profile`, `name`, `location`, `website`, `wishlist`.
   *Default: they stay as they are. Verify a call once on a throwaway account (method, path, body keys, and the
   effect read back) and a v6.x wave ships it.*
5. **Probes on the connected account (§3).** *Default: yes. GET only, through `_of/`, with the read-scope `v6-probe`
   key, at most 50 requests 1 s apart, stopping on the first anomaly. Status, key names and booleans are recorded,
   never values; the key's request-log rows are deleted afterwards.*
6. **Money and identity writes:** `POST payouts/request-manual-withdrawal`, `PATCH payouts/payout-frequency`,
   `PATCH settings/subscription-price`, and a username change through `settings/profile`. *Default: no named route in
   v6, even if captured; the withdrawal stays passthrough-only unless you ask. `username` is a 422.*
7. **A delete-level key** (carried from plan-v5 Q3). v6 ships DELETE on posts, stories, vault folders, tracking and
   trial links, promotions and bundles. *Default: no new key level. `write` already reaches DELETE through the
   passthrough.*
8. **Version.** *Default: v2.1.0, additive. Reshaping a v5 route, declaring a v5 cursor with a 422, or retrofitting
   the §2.2 422 rule would make the release v3.0.0.*
9. **Notification types without a verified OF value** (purchases, tags, favorited, promotions). *Default: a 422
   (`unsupported_type`). Notifications are never probed (§3).*
10. **Does reference parity still outrank the client stats ask (`future-client-story-ask.md`)?** *Default: yes for
    this wave; the welcome-template route it needs (`GET settings/welcome-message`) is in this wave.*
