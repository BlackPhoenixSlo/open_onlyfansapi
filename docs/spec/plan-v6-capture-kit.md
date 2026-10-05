# Plan v6 capture kit: the `?` rows that need an OF capture

One-sitting checklist for the owner (plan-v6 §8 "Owner captures", §9 Q1). Goal: for each `?` row, record which OF
call the matching action makes: method, path under `https://onlyfans.com/api2/v2/`, query names and body key names.
A v6.x wave then ships the rows (plan-v6 §1.2: a write needs its body and effect seen once).

**Where to capture.** On onlyfans.com, logged in as the creator, devtools open. The reference product's dashboard
only calls the reference's own API, so it never shows OF's path; use it only to compare (its Playground shows the
reference body for a tail). Menu names below are from the OF creator UI as we know it. If a label differs, use the
nearest equivalent and note it under the row's heading.

**Scope.** 72 rows (plan-v6 §9 Q1: 104 `?` minus 22 *ref*, 7 `banking/*`, 3 §9 Q6 money writes), plus 10 rows that
became `?` after the §3 probes or the implementation review (marked **post-probe**). 33 rows are parked (last section).

## (a) How to capture (10 steps)

1. Open devtools (Cmd+Opt+I) → **Network**; tick **Preserve log**; pick the **Fetch/XHR** filter.
2. Type `api2/v2` in the filter box (OF's API host path), then press the clear button (⊘) before each row.
3. Do the action in the row's "Do" field, once.
4. Find the request that matches "Look for" (newest first; ignore polling such as `users/notifications/count`).
5. Right-click it → **Copy** → **Copy as cURL (bash)**.
6. Paste it into `~/of-captures/<file>.md` under a heading `## <row id> <METHOD tail>` (file names are in each page).
7. If the response matters (a GET), also right-click → **Copy response** and paste it under the cURL.
8. Add one line `effect:` saying what changed in the UI (Q4 asks for the effect read back on writes).
9. Redact nothing: the file stays local and is never committed (`.gitignore` blocks `of-captures/`, `*.capture.md`).
10. Tick the box here, or in your own copy of this list, and move on. No match? Check the **WS** tab and write `none seen`.

**Write safety.** `[R]` is a read. `[W]` is a write you can undo in the UI; undo it straight after and capture the undo
too. `[W!]` is visible to fans or one-way: do it on a throwaway account or test item (§9 Q4), or skip it.
The capture files hold live session cookies: log out of onlyfans.com when you finish, which invalidates them.

## (b) Rows by page

Row ids: `v5#n` = plan-v6 "v5 open rows"; `posts#n`, `media#n`, `stories#n`, `sfl#n` = content; `tl#n`, `trl#n`,
`promo#n`, `bundles#n` = promo; `set#n`, `rf#n`, `notif#n` = settings. Tails are relative to `/v1/{account}/`.

### 1. Chats (`/my/chats`) → `chats.md`

- [ ] **v5#27** `DELETE chats/{chat_id}` [W!] — Do: chat list → a test chat's ⋯ → Delete conversation. Look for: the
  method and path (a `chats/{id}` delete?), any query (for example "for both sides") and body keys.
- [ ] **v5#28** `POST chats/{chat_id}/typing` [R-ish] — Do: type in a chat's box for 3 s, do not send. Look for: a
  POST while typing; if Fetch/XHR shows none, the **WS** tab frame sent while typing (its key names).

### 2. Queue and scheduled mass messages (`/my/queue`) → `queue.md`

Schedule one mass message first, far in the future, to a list holding only a test fan.
- [ ] **v5#2** `GET mass-messaging/{mass_messaging}` [R] **post-probe** — Do: open that scheduled message from the
  queue. Look for: the GET carrying its queue id (P02 tried `messages/queue/{id}`, inconclusive).
- [ ] **v5#30** `PUT, PATCH mass-messaging/{mass_messaging}` (2 ops) [W] — Do: edit its text and save. Look for:
  method (PUT or PATCH), path, every body key (text, price, media, schedule date, recipient lists).
- [ ] **v5#29** `POST messages/{queue_id}/attach-tags` [W] — Do: on that message, tag a collaborator (release-form
  tag) and save. Look for: a separate call or extra body keys on the save (`rfTag`-style names).
- [ ] **v5#31** `PUT queue/{queue_id}/publish` [W!] — Do: queue → the test message → Publish/Send now. Look for:
  method, path, body. Do it last: it sends the message.

### 3. Statistics → Engagement → Messages (`/my/statistics/engagement/messages`) → `engagement.md`

- [ ] **v5#20** `GET engagement/messages/direct-messages/chart` [R] — Do: Direct messages tab; change the period
  once. Look for: the chart call's path and query names (dates, `withTotal`?).
- [ ] **v5#21** `GET engagement/messages/mass-messages/chart` [R] **post-probe** — Do: Mass messages tab; change the
  period. Look for: the chart path (P06 tried `messages/queue/chart`, failed) and query names.
- [ ] **v5#23** `GET engagement/messages/{message_id}/buyers` [R] — Do: in the mass messages list click a paid
  message's purchases or buyers count. Look for: the path with the message id, paging query names.

### 4. Statistics → Engagement → Posts and Stories → `engagement.md`

- [ ] **posts#17** `GET posts/{post_id}/stats` [R] — Do: Posts tab → click one post (or a post's ⋯ → Statistics on
  your profile). Look for: a call carrying that post id (`posts/chart` and `posts/top` are account-wide, not it).
- [ ] **stories#14** `GET stories/{story_id}/stats` [R] — Do: Stories tab → click one story. Look for: a call
  carrying the story id (`stories/chart`, `stories/top` are account-wide).

### 5. Statistics → Fans, and Statements (`/my/statistics/fans`, `/my/statements/...`) → `stats.md`

- [ ] **v5#24** `GET statistics/subscriber-metrics` [R] — Do: open the Fans statistics overview. Look for: every
  `api2/v2` call the page makes; the reference may compute this, so record all of them with their query names.
- [ ] **v5#25** `GET statistics/total-transactions` [R] — Do: Statements → Earnings; note the totals block. Look
  for: the call returning the totals (path, query names).
- [ ] **v5#3** `GET me/top-percentage` [R] — Do: find the "top x%" badge (statements or your profile header). Look
  for: the call whose response holds the percentage (the key name, not the value).
- [ ] **v5#18** `GET chargebacks/statistics` [R] **post-probe** — Do: Statements → Chargebacks; change the period.
  Look for: the chart or summary call (P05 tried `payouts/chargebacks/chart`) and its query names.

### 6. Fans and lists (`/my/collections/user-lists`, a fan's chat sidebar) → `fans.md`

- [ ] **v5#8** `GET fans/{user_id}/subscriptions-history` [R] — Do: open a fan's chat sidebar or profile → the
  subscription history or "subscribed since" detail. Look for: a call with the fan id returning past periods.
- [ ] **v5#7** `GET fans/{fan_id}/notes` [R] **post-probe** — Do: open that fan's note in the sidebar. Look for: the
  GET that returns the note text (P04 only showed `notice` exists on `users/{id}`).
- [ ] **v5#9** `GET user-lists/{userListId}/users/pinned` [R] — Do: open a custom list that has a pinned user. Look
  for: a "pinned" path or query on the list's users call.
- [ ] **v5#34** `POST user-lists/{userListId}/users/{userId}/pin` [W] — Do: in that list pin a user, then unpin.
  Look for: method and path of both (toggle or set?), body keys.
- [ ] **v5#33** `DELETE user-lists/{userListId}/users` [W] — Do: remove a user from a custom list (re-add after).
  Look for: one id in the path, or ids in a body/query (key name), and whether bulk select sends one call.
- [ ] **v5#5** `GET users/blocked` [R] **post-probe** — Do: Collections (or Settings → Privacy) → Blocked. Look for:
  the list call (path or list type word, paging query).
- [ ] **v5#6** `GET users/restricted` [R] **post-probe** — Do: the Restricted list, same place. Look for: as v5#5.

### 7. Your profile → posts (`/<your username>`) → `posts.md`

Use one existing post for the reversible rows. Do the comment rows in this order, on your own post.
- [ ] **posts#4** `POST posts/labels` [W] — Do: profile → post labels/tabs → add a label "test" (delete it after).
  Look for: path and body keys.
- [ ] **posts#6** `PUT, PATCH posts/{post_id}` (2 ops) [W] — Do: post ⋯ → Edit → change one word → Save; change it
  back. Look for: method, path, every body key (Q4: `edit_post` is unverified).
- [ ] **posts#8** `POST posts/{post_id}/archive` [W] — Do: post ⋯ → Archive. Look for: method, path, body.
- [ ] **posts#18** `POST posts/{post_id}/unarchive` [W] — Do: Archived → that post → Restore/Unarchive. Look for: as
  posts#8.
- [ ] **posts#16** `POST posts/{post_id}/pin` [W] — Do: post ⋯ → Pin to profile, then Unpin. Look for: same call
  both times (toggle) or two calls (set); body keys. Q4.
- [ ] **posts#10** `POST posts/{post_id}/comments` [W!] — Do: write the comment "test". Look for: path and body keys.
- [ ] **posts#12** `POST …/comments/{comment_id}/like` [W] — Do: like that comment. Look for: method and path.
- [ ] **posts#13** `DELETE …/comments/{comment_id}/like` [W] — Do: unlike it. Look for: DELETE, or the same POST
  again (toggle).
- [ ] **posts#14** `POST …/comments/{comment_id}/pin` [W] — Do: pin that comment. Look for: method and path.
- [ ] **posts#15** `DELETE …/comments/{comment_id}/pin` [W] — Do: unpin it. Look for: as posts#13.
- [ ] **posts#11** `DELETE posts/{post_id}/comments/{comment_id}` [W] — Do: delete the comment. Look for: method and
  path.

### 8. Vault (`/my/vault`) → `vault.md`

- [ ] **media#15** `DELETE media/vault/lists/{list_id}/media` [W] — Do: in a custom vault list select one item →
  Remove from list (add it back after). Look for: method, path, body/query key for the media ids.
- [ ] **media#8** `DELETE media/vault/delete-media` [W!] one-way — Do: delete one throwaway item from the vault.
  Look for: method, path, body keys (Q4: `hide_vault_media`'s body came from OF's web bundle).

### 9. Stories and highlights (your profile) → `stories.md`

Post one test story first (that is stories#2), use it for the rest, delete it at the end.
- [ ] **stories#2** `POST stories` [W!] — Do: add a story with one vault image. Look for: the JSON call after any
  upload request (skip binary uploads): path and body keys (media ids, text, link).
- [ ] **stories#15** `GET stories/{story_id}/viewers` [R] — Do: open your story → viewers (eye icon). Look for: path
  and paging query.
- [ ] **stories#13** `POST stories/{story_id}/mark-as-watched` [R-ish] — Do: watch a story of an account you follow.
  Look for: the call fired on view (path, body keys).
- [ ] **stories#5** `POST stories/highlights` [W] — Do: profile → New highlight → add the test story → title "test".
  Look for: path and body keys (title, cover, story ids).
- [ ] **stories#6** `GET stories/highlights/{highlight_id}` [R] — Do: open that highlight. Look for: the GET with
  its id.
- [ ] **stories#7** `PUT, PATCH stories/highlights/{highlight_id}` (2 ops) [W] — Do: edit its title or cover, save.
  Look for: method and body keys.
- [ ] **stories#9** `PATCH stories/highlights/{highlight_id}/{story_id}` [W] — Do: add a second story to it (or
  reorder). Look for: a call with both ids, or the story ids in the body.
- [ ] **stories#10** `DELETE stories/highlights/{highlight_id}/{story_id}` [W] — Do: remove one story from it.
  Look for: as stories#9.
- [ ] **stories#8** `DELETE stories/highlights/{highlight_id}` [W] — Do: delete the highlight. Look for: method,
  path. Then delete the test story (already shipped as `DELETE stories/{story_id}`).

### 10. Saved for later (queue → Saved for later, or Settings) → `saved-for-later.md`

Note the current setting first and restore it after.
- [ ] **sfl#4** `PATCH …/messages/settings/enable-or-update-automatic-messaging` [W] — Do: turn automatic sending
  of saved messages on (or change its interval), save. Look for: path (`users/settings/chat`?) and body keys.
- [ ] **sfl#3** `PATCH …/messages/settings/disable-automatic-messaging` [W] — Do: turn it off. Look for: as sfl#4.
- [ ] **sfl#8** `PATCH …/posts/settings/enable-or-update-automatic-posting` [W] — Do: same for saved posts. Look for:
  path (`users/settings/post`?) and body keys.
- [ ] **sfl#7** `PATCH …/posts/settings/disable-automatic-posting` [W] — Do: turn it off. Look for: as sfl#8.

### 11. Tracking links (Promotions → Tracking links) → `tracking-links.md`

- [ ] **tl#3** `GET tracking-links/{tracking_link_id}` [R] **post-probe** — Do: open one link's detail. Look for:
  the GET with its id (P12's `campaigns/{id}` failed).
- [ ] **tl#7** `GET tracking-links/{tracking_link_id}/stats` [R] — Do: on the detail, change the chart period. Look
  for: `campaigns/chart`-like call: does it carry the link id, and under which query name?
- [ ] **tl#8** `GET tracking-links/{tracking_link_id}/subscribers` [R] — Do: the detail's subscribers/fans list.
  Look for: path, paging query.
- [ ] **shared-tl list** `GET shared-tracking-links` [R] — Do: a "Shared" tab or links shared with you, if present.
  Look for: path. Not found: write `no such page`.
- [ ] **shared-tl delete** `DELETE shared-tracking-links/{shared_tracking_link_id}` [W] — Do: remove one shared link,
  if the page exists. Look for: method, path.

### 12. Free trial links (Promotions → Free trial links) → `trial-links.md`

- [ ] **trl#2** `POST trial-links` [W] — Do: create a trial link "test" (delete it after, already shipped). Look for:
  path and every body key (Q4: `create_trial_link`'s body is unverified).
- [ ] **trl#3** `GET trial-links/{trial_link_id}` [R] **post-probe** — Do: open one link's detail. Look for: the GET
  with its id (P13's `trials/{id}` failed).
- [ ] **trl#7** `GET trial-links/{trial_link_id}/stats` [R] — Do: the detail's chart. Look for: `trials/stats` or
  `trials/chart` with the link id under which query name?
- [ ] **trl#8** `GET trial-links/{trial_link_id}/subscribers` [R] — Do: the detail's subscribers list. Look for:
  path, paging query.
- [ ] **shared-trl list** `GET shared-trial-links` [R] — Do: as shared-tl list. Look for: path.
- [ ] **shared-trl delete** `DELETE shared-trial-links/{shared_trial_link_id}` [W] — Do: as shared-tl delete.

### 13. Promotions and bundles (your profile → Promotions; Settings → Subscription) → `promotions.md`

- [ ] **promo#2** `POST promotions` [W!] — Do: start a promotion (new subscribers, shortest duration). Look for: path
  and body keys, especially the type, expiration days and free-trial days (no verified OF field yet).
- [ ] **promo#4** `POST promotions/{promotion_id}/stop` [W] — Do: stop it straight away. Look for: method, path.
- [ ] **bundles#6** `POST bundles` [W!] — Do: Subscription → add a bundle, then delete it in the UI. Look for: path
  and body keys (`months`, `discount`, `price`?). The delete capture is bundles#7 (parked): keep it anyway.

### 14. Settings (`/my/settings`) → `settings.md`

- [ ] **set#14** `GET settings/welcome-message` [R] **post-probe** — Do: Settings → Chats/Messaging → Welcome
  message. Look for: the GET that loads it (P23's template call failed).
- [ ] **set#15** `POST settings/welcome-message` [W] — Do: change the welcome text and save; restore after. Look for:
  path and body keys (Q4: `upsert_welcome_template`).
- [ ] **set#16** `PATCH settings/welcome-message` [W] — Do: toggle the welcome message off and on. Look for: path and
  body key (Q4: `set_reply_on_subscribe`).
- [ ] **set#13** `POST settings/username-exists` [R] — Do: Account → Username: type a new name, do NOT save. Look
  for: the check call, its body or query key, and the response key that says taken or free.
- [ ] **set#3** `PUT settings/blocked-countries` [W] — Do: Privacy → geo-blocking: add one country, save, remove it,
  save. Look for: method, path, body key (full list or one code?).
- [ ] **set#5** `PATCH settings/drm` [W] — Do: toggle the DRM/content-protection switch and back. Look for: method,
  path, body key.
- [ ] **set#8** `POST settings/social-media-buttons` [W] — Do: Profile → social buttons → add "test". Look for: path,
  body keys.
- [ ] **set#10** `PUT, PATCH settings/social-media-buttons/{button_id}` (2 ops) [W] — Do: edit that button's label.
  Look for: method, body keys.
- [ ] **set#9** `POST settings/social-media-buttons/reorder` [W] — Do: drag it up one place, then back. Look for:
  path, body key (id order?).
- [ ] **set#11** `DELETE settings/social-media-buttons/{button_id}` [W] — Do: delete the test button. Look for:
  method, path.

### 15. Release forms (Settings → Release forms, or the post composer's tag picker) → `release-forms.md`

- [ ] **rf#1** `GET release-forms` [R] — Do: open the release forms list. Look for: path, paging query.
- [ ] **rf#4** `GET release-forms/mentions` [R] — Do: in the post composer type `@` or open tagged posts for one
  form. Look for: the call that lists mentions (path, query names).
- [ ] **rf#2** `POST release-forms/create-invitation-link` [W] — Do: invite a co-performer → generate a link. Look
  for: path, body keys.
- [ ] **rf#3** `POST release-forms/create-release-form` [W] — Do: add a release form (skip the document upload if it
  needs real ID; capture only the JSON call). Look for: path, body keys.
- [ ] **rf#5** `PATCH release-forms/rename` [W] — Do: rename one form/guest entry and back. Look for: path, body keys.
- [ ] **rf#7** `PATCH release-forms/toggle-show` [W] — Do: hide one entry and show it again. Look for: path, body keys.

### 16. Notifications (`/my/notifications`) → `notifications.md`

- [ ] **notif#8** `GET notifications` [R] **post-probe** — Do: open the page with unread items. Look for: the list
  call, and whether any POST/PUT follows it that marks items read (the reason the row was moved to `?`).
- [ ] **notif#11** `GET notifications/search-users` [R] — Do: the page's user search box, type 3 letters. Look for:
  path and query names.
- [ ] **notif#13** `PUT notifications/tabs-order` [W] — Do: reorder the tabs (settings icon) and back. Look for:
  method, path, body key.
- [ ] **notif#10** `POST notifications/mark-all-as-read` [W] one-way — Do: Mark all as read. Look for: method, path.

## (c) What to do with the captures

1. Keep them in `~/of-captures/<file>.md` (the file names above), outside the repo. `of-captures/` and
   `*.capture.md` are in `.gitignore` as a safety net only; never move the files into the repo.
2. Start a session with: **"map the ? rows from ~/of-captures"**. That session reads only the method, the path, the
   query names and the body/response key names; it never copies cookies, header values, ids, names, text or amounts
   into the repo (plan-v6 §2.5). It writes the mapping into plan-v6 (or a v6.x plan) and the inventory, and ships
   the rows under §1.2.
3. When the mapping is merged, delete `~/of-captures/` and log out of onlyfans.com.

**2026-10-05:** no per-row captures were produced, so all 72 rows (and the 10 post-probe rows) stay open. A 3-day
log of inbound OF socket frames was mapped to the webhook events instead: `plan-v6-ws-events.md`.
When that mapping is merged, delete `~/of-capture/` (singular: the frame log, and a session copy with cookies,
under `state/`).

## Not capturable / parked (33 rows)

- **22 *ref* rows** (plan-v6 §8, §9 Q3): the reference's own stored data, not an OF call.
  - `GET session` (v5#4): the reference's session record.
  - `GET workflows/account-performance/starting-revenues` (v5#26): reference workflow revenue.
  - tracking-links and trial-links `cohort-arps`, `spenders` (4): reference-computed fan cohorts.
  - `GET, POST, DELETE tracking-links/{id}/tags`, `trial-links/{id}/tags`, `shared-tracking-links/{id}/tags`,
    `shared-trial-links/{id}/tags` (12): reference-side link tags; OF has no link tags.
  - `GET stored/tracking-links`, `stored/trial-links`, `stored/shared-tracking-links`, `stored/shared-trial-links`
    (4): the reference's cached copies of links.
- **7 `banking/*` rows** (v5#10–16, §9 Q2): `available-payout-systems`, `countries`, `details/account-country`,
  `details/bank`, `details/dac7-form`, `details/legal-form`, `details/legal-info`: bank, tax and identity data;
  never probed or captured.
- **3 §9 Q6 money writes**: v5#35 `PATCH payouts/payout-frequency`, v5#36 `POST payouts/request-manual-withdrawal`,
  set#12 `PATCH settings/subscription-price`: they move money or prices; no named route even if captured.
- **bundles#7** `DELETE bundles/{bundle_id}` (post-review, §9 Q6): changes pricing; parked like the Q6 writes (a
  capture from page 13 may be kept, but no route ships without your say-so).
