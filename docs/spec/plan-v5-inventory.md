# Plan v5 parity inventory

Date: 2026-10-02. Generated from the sources below with python3; nothing in this file is copied from the mirror except route URIs, route names, method lists, event names and payload key names (values replaced by generic types).

## Sources

1. `~/of-reference/onlyfansapi-openapi.yaml` (OpenAPI 3.0.3, 225 paths / 298 operations, 56 tags).
2. Dashboard mirror `app.onlyfansapi.com/` (gitignored): `props.ziggy.routes` from the `<script data-page="app">` payload (959 routes; 445 under `api/`; 236 under `api/{account}/`), and `props.examplePayloads` from the mirror's webhooks page (72 events). Event names cross-checked against the mirror's `build/assets/event-groups-*.js`.
3. `~/of-reference/onlyfansapi-webhook-events.md`, plus https://docs.onlyfansapi.com/webhooks/available-events.md, `/webhooks/protecting-your-webhooks.md` and `/webhooks/delivery-and-retries.md` (fetched 2026-10-02).
4. Ours: `apps/api/src` (Fastify routes, `contracts.ts` event enum, `lib/signature.ts`, `plugins/actor.ts`), `docs/webhooks.md`, and `services/upstream/app.py` (the `/of` router that `ALL /v1/{account}/*` forwards to) plus `services/upstream/of_client.py`.

**Precedence rule:** where the yaml and the route table disagree, the route table wins for paths and methods, the yaml wins for request/response bodies.

## Counts

| Item | Count |
|---|---|
| Theirs, per-account named routes (route table `api/{account}/...`, excl. `_of` passthrough) | 235 (233 in scope; 2 AI fan-summary routes excluded) |
| Theirs, non-account routes (route table `api/...`) | 209 (32 in scope; 177 excluded, see F) |
| Theirs, in-scope rows total (A + B) | 265 |
| Ours, public API routes | 21 = 13 named `/v1` gateway routes + 8 upstream `/of` routes reachable through `ALL /v1/{account}/*` (proxy catch-all and 12 dashboard/ops routes not counted) |
| Matched (have + partial) | 18 = 1 have + 17 partial (A: 0 + 8; B: 1 + 9) |
| Missing | 247 (A: 225; B: 22) |
| Missing rows where an `OFClient` method already exists (`client:` in Note) | 96 (A: 94; B: 2) |
| Webhook events: examplePayloads / documented (OnlyFans) / in scope | 72 / 34 / 26 |
| Webhook events matched | 3 partial (`messages.received`, `messages.sent`, `accounts.session_expired`), 5 catalogued but never emitted, 18 no counterpart |

Excluded from every count above: the 30 `api/_internal/*` (other than FansBot) and `api/_auth_app/*` infrastructure routes (their dashboard plumbing, F), and API-key management, which has no `api/` routes at all (keys are dashboard-only, D.3).

Status rules: "have" = same resource + verb and compatible request/response; "partial" = route exists but path suffix, query, body or response shape clearly differ; "missing" = no route. Prefix differences (`api/{account}` vs `/v1/{account}`) are ignored.

**Global response-shape gap:** their yaml examples wrap responses as `{data, _meta}` (218 ops) or `{data, _meta, _pagination}` (34 ops), with `_meta = {_cache, _credits, _rate_limits}` (235) or `{_cache, _credits}` (17). The upstream `/of` routes return the raw OnlyFans body, so every proxied route is at best "partial" until an envelope adapter exists. Their `GET api/accounts` (bare array) and `GET api/whoami` (`{api_key, team}`) are the unwrapped exceptions.

## v5 execution notes (2026-10-02, orchestrator)

Status column of section A is as of the plan date; the live list is `docs/spec/parity/baseline.txt` (`check --have`).
Shipped by the waves: P2 chats 22 new (25 with v4), P3 fans 33 operations, P4 money 11. The rows below did not ship.

**`?` rows (OF path or body unknown; skipped, not guessed; reachable only through `_of/`):**
- P2: `GET chats/{chat_id}/messages/{message_id}`, `GET mass-messaging/{mass_messaging}`.
- P3: `GET me/top-percentage`, `GET session` (reference-side session record, no OF call), `GET users/blocked`,
  `GET users/restricted` (both give 422 from `users/{username}` on purpose), `GET fans/{fan_id}/notes`,
  `GET fans/{user_id}/subscriptions-history`, `GET user-lists/{userListId}/users/pinned`.
- P4: all 7 `banking/*`, `GET chargebacks`, `GET chargebacks/statistics`, `GET engagement/messages/direct-messages`,
  `…/direct-messages/chart`, `…/mass-messages/chart`, `…/top-message`, `…/{message_id}/buyers`,
  `GET statistics/subscriber-metrics`, `GET statistics/total-transactions`,
  `GET workflows/account-performance/starting-revenues`.

**deferred-write rows (plan §Phases 2–4):** unchanged, 10 rows.

**Mapping corrections and reshapes decided in code:**
- `GET mass-messaging` → `scheduled_messages` (OF `/messages/queue`); `GET mass-messaging/overview` →
  `mass_message_history` (OF `/users/me/stats/messages/group`, also behind `GET engagement/messages/mass-messages`).
- `POST mass-messaging` ships single-recipient only (`userIds` max 1, `scheduledDate` required, extra fields 422).
- `GET chats/{chat_id}/messages/pinned` returns the rows, not OF's `{list,hasMore}` (hasMore is wrong on that filter).
- `POST chats/{chat_id}/messages/{message_id}/pin` guards OF's toggle with a pinned read; unexpected shape → 502.
- `users/{user_id}/posts` pages only for `order=publish_date&sort=desc` (tailMarker cursor).
- `POST user-lists/{userListId}/users` loops one OF call per id (≤50); partial state is reported in the body.
- `GET subscribers/statistics` → `subscribers_chart`; `GET statistics/reach/profile-visitors` → `my_profile_stats`;
  `GET statistics/statements/earnings` → `earnings_chart`; `GET engagement/messages/mass-messages` →
  `mass_message_history` (all from client docstrings, not the inventory's `client:` notes).
- Reference parameters the client cannot send are accepted and dropped; each handler docstring lists them.

**Owner live-check list (inferred OF paths or query names):** `GET fans/latest`, `GET fans/top`,
`GET subscribers/statistics`, `GET users/{user_id}/posts` order/sort composition, `GET statistics/reach/profile-visitors`,
`GET statistics/statements/earnings`, P4 date formats (`YYYY-MM-DD` vs `YYYY-MM-DD HH:MM:SS`), and the §9 Q6
passthrough mapping.

## A. Per-account named routes

Paths are relative: theirs to `api/{account}`, ours to `/v1/{account}`. Ours resolve via the gateway proxy to upstream `/of/<rest>`. Note column: Laravel route name (omitted when auto-generated), `client:` = an `OFClient` method in `services/upstream/of_client.py` that already wraps the matching OnlyFans call (route not exposed), "not in yaml" = route table only. No streams routes exist in either of their sources.

### A.0 Summary by group

| Group | Routes | have | partial | missing |
|---|---|---|---|---|
| Account / me | 4 | 0 | 1 | 3 |
| Chats & messages | 21 | 0 | 3 | 18 |
| Mass messaging & engagement | 12 | 0 | 0 | 12 |
| Queue & saved-for-later | 11 | 0 | 0 | 11 |
| Posts, comments, labels | 18 | 0 | 2 | 16 |
| Media & vault | 16 | 0 | 2 | 14 |
| Users & profile content | 13 | 0 | 0 | 13 |
| Fans (subscribers) & following | 13 | 0 | 0 | 13 |
| Lists | 11 | 0 | 0 | 11 |
| Stories & highlights | 15 | 0 | 0 | 15 |
| Statistics | 6 | 0 | 0 | 6 |
| Earnings: transactions, payouts, chargebacks, banking | 18 | 0 | 0 | 18 |
| Promotions & bundles | 7 | 0 | 0 | 7 |
| Tracking & trial links | 36 | 0 | 0 | 36 |
| Notifications | 6 | 0 | 0 | 6 |
| Settings | 16 | 0 | 0 | 16 |
| Release forms | 7 | 0 | 0 | 7 |
| Giphy | 2 | 0 | 0 | 2 |
| Undocumented (route table only, no yaml tag) | 1 | 0 | 0 | 1 |
| **Total** | 233 | 0 | 8 | 225 |

### Account / me (4)

yaml tags: Account

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/me` | `/users/me` | partial | `me.show`; path differs (ours /users/me); raw OF body (theirs wraps {data,_meta}) |
| GET | `/me/model-start-date` | — | missing | client: `my_start_date` |
| GET | `/me/top-percentage` | — | missing | — |
| GET | `/session` | — | missing | `account-session.show`; not in yaml |

### Chats & messages (21)

yaml tags: Chat Messages, Chats

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/chats` | `/chats` | partial | `chats.index`; query: ours limit/offset/order; theirs adds skip_users/filter/query; raw OF body (theirs wraps {data,_meta}) |
| POST | `/chats/mark-as-read` | — | missing | `chats.mark-all-as-read`; client: `mark_all_chats_read` |
| DELETE | `/chats/{chat_id}` | — | missing | `chats.destroy` |
| POST | `/chats/{chat_id}/hide` | — | missing | `chats.hide`; client: `hide_chat` |
| POST | `/chats/{chat_id}/mark-as-read` | — | missing | `chats.mark-as-read`; client: `mark_chat_read` |
| POST | `/chats/{chat_id}/mark-as-unread` | — | missing | `chats.mark-as-unread`; client: `mark_chat_unread` |
| GET | `/chats/{chat_id}/media` | — | missing | `chats.media`; client: `chat_media` |
| GET | `/chats/{chat_id}/messages` | `/chats/{chatId}/messages` | partial | `messages.index`; query: ours limit/order/id; theirs limit/filter/first_id/last_id/order/skip_users; raw OF body (theirs wraps {data,_meta}) |
| POST | `/chats/{chat_id}/messages` | `/chats/{chatId}/messages` | partial | `messages.store`; body: ours text/price/mediaFiles/previews/lockedText; theirs adds replyToMessageId/giphyId/rfTag/rfPartner/rfGuest/blockBannedWords; raw OF body (theirs wraps {data,_meta}) |
| GET | `/chats/{chat_id}/messages/pinned` | — | missing | `messages.pinned`; client: `get_pinned_messages` |
| GET | `/chats/{chat_id}/messages/search` | — | missing | `messages.search`; client: `search_chat` |
| GET | `/chats/{chat_id}/messages/{message_id}` | — | missing | `messages.show` |
| DELETE | `/chats/{chat_id}/messages/{message_id}` | — | missing | `messages.destroy`; client: `unsend_message` |
| POST | `/chats/{chat_id}/messages/{message_id}/like` | — | missing | `messages.like`; client: `like_message` |
| POST | `/chats/{chat_id}/messages/{message_id}/pin` | — | missing | `messages.pin`; client: `pin_message` |
| DELETE | `/chats/{chat_id}/messages/{message_id}/unlike` | — | missing | `messages.unlike`; client: `unlike_message` |
| DELETE | `/chats/{chat_id}/messages/{message_id}/unpin` | — | missing | `messages.unpin`; client: `unpin_message` |
| POST | `/chats/{chat_id}/mute` | — | missing | `chats.mute`; client: `mute_chat` |
| POST | `/chats/{chat_id}/typing` | — | missing | `chats.typing` |
| DELETE | `/chats/{chat_id}/unmute` | — | missing | `chats.unmute`; client: `unmute_chat` |
| POST | `/messages/{queue_id}/attach-tags` | — | missing | `messages.attach-tags` |

### Mass messaging & engagement (12)

yaml tags: Engagement / Messages, Mass Messaging

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/engagement/messages/direct-messages` | — | missing | — |
| GET | `/engagement/messages/direct-messages/chart` | — | missing | — |
| GET | `/engagement/messages/mass-messages` | — | missing | — |
| GET | `/engagement/messages/mass-messages/chart` | — | missing | — |
| GET | `/engagement/messages/top-message` | — | missing | — |
| GET | `/engagement/messages/{message_id}/buyers` | — | missing | `engagement.messages.buyers` |
| GET | `/mass-messaging` | — | missing | `mass-messaging.index`; client: `scheduled_messages` (v5 execution: the index returns queue entries; `mass_message_history` backs `/mass-messaging/overview`) |
| POST | `/mass-messaging` | — | missing | `mass-messaging.store`; client: `schedule_message` |
| GET | `/mass-messaging/overview` | — | missing | client: `mass_message_history` (v5 execution) |
| GET | `/mass-messaging/{mass_messaging}` | — | missing | `mass-messaging.show` |
| PUT/PATCH | `/mass-messaging/{mass_messaging}` | — | missing | `mass-messaging.update` |
| DELETE | `/mass-messaging/{mass_messaging}` | — | missing | `mass-messaging.destroy`; client: `cancel_scheduled` |

### Queue & saved-for-later (11)

yaml tags: Queue, Saved For Later (Messages), Saved For Later (Posts)

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/queue` | — | missing | client: `schedules` |
| GET | `/queue/counts` | — | missing | client: `schedule_counters` |
| PUT | `/queue/{queue_id}/publish` | — | missing | — |
| GET | `/saved-for-later/messages` | — | missing | `saved-for-later-messages.index`; client: `schedules_later_chat` |
| GET | `/saved-for-later/messages/settings` | — | missing | `saved-for-later-messages.settings` |
| PATCH | `/saved-for-later/messages/settings/disable-automatic-messaging` | — | missing | `saved-for-later-messages.disable-automatic-messaging` |
| PATCH | `/saved-for-later/messages/settings/enable-or-update-automatic-messaging` | — | missing | `saved-for-later-messages.enable-or-update-automatic-messaging` |
| GET | `/saved-for-later/posts` | — | missing | `saved-for-later-posts.index`; client: `schedules_later_post` |
| GET | `/saved-for-later/posts/settings` | — | missing | `saved-for-later-posts.settings` |
| PATCH | `/saved-for-later/posts/settings/disable-automatic-posting` | — | missing | `saved-for-later-posts.disable-automatic-posting` |
| PATCH | `/saved-for-later/posts/settings/enable-or-update-automatic-posting` | — | missing | `saved-for-later-posts.enable-or-update-automatic-posting` |

### Posts, comments, labels (18)

yaml tags: Post Comments, Post Labels, Posts

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/posts` | `/posts` | partial | `posts.index`; query: ours limit/offset; theirs adds query/order/sort/pinned/counters/minimumPublishDate; raw OF body (theirs wraps {data,_meta}) |
| POST | `/posts` | — | missing | `posts.store`; client: `create_post` |
| GET | `/posts/labels` | — | missing | `labels.index` |
| POST | `/posts/labels` | — | missing | `labels.store` |
| GET | `/posts/{post_id}` | `/posts/{postId}` | partial | `posts.show`; raw OF body (theirs wraps {data,_meta}) |
| PUT/PATCH | `/posts/{post_id}` | — | missing | `posts.update`; client: `edit_post` |
| DELETE | `/posts/{post_id}` | — | missing | `posts.destroy`; client: `delete_post` |
| POST | `/posts/{post_id}/archive` | — | missing | `posts.archive` |
| GET | `/posts/{post_id}/comments` | — | missing | `comments.index`; client: `post_comments` |
| POST | `/posts/{post_id}/comments` | — | missing | `comments.store`; client: `comment_on_post` |
| DELETE | `/posts/{post_id}/comments/{comment_id}` | — | missing | `comments.destroy` |
| POST | `/posts/{post_id}/comments/{comment_id}/like` | — | missing | `comments.like` |
| DELETE | `/posts/{post_id}/comments/{comment_id}/like` | — | missing | `comments.unlike` |
| POST | `/posts/{post_id}/comments/{comment_id}/pin` | — | missing | `comments.pin` |
| DELETE | `/posts/{post_id}/comments/{comment_id}/pin` | — | missing | `comments.unpin` |
| POST | `/posts/{post_id}/pin` | — | missing | `posts.pin`; client: `pin_post` |
| GET | `/posts/{post_id}/stats` | — | missing | `posts.stats` |
| POST | `/posts/{post_id}/unarchive` | — | missing | `posts.unarchive` |

### Media & vault (16)

yaml tags: Media, Media Vault, Media Vault Lists

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/media/download/drm/{media_id}` | — | missing | `media.download-drm` |
| GET | `/media/download/{cdnUrl}` | — | missing | — |
| POST | `/media/scrape` | — | missing | — |
| POST | `/media/upload` | — | missing | — |
| GET | `/media/uploads/{upload}/status` | — | missing | `media.upload-status` |
| GET | `/media/vault` | `/vault/media` | partial | `vault.index`; path differs (ours /vault/media); query: ours limit/offset; theirs query/field/type/list/sort/limit/offset; raw OF body (theirs wraps {data,_meta}) |
| POST | `/media/vault` | — | missing | `vault.store` |
| DELETE | `/media/vault/delete-media` | — | missing | client: `hide_vault_media` |
| GET | `/media/vault/lists` | — | missing | `lists.index`; client: `vault_lists` |
| POST | `/media/vault/lists` | — | missing | `lists.store`; client: `create_vault_list` |
| GET | `/media/vault/lists/{list_id}` | — | missing | `lists.show` |
| PUT/PATCH | `/media/vault/lists/{list_id}` | — | missing | `lists.update`; client: `rename_vault_list` |
| DELETE | `/media/vault/lists/{list_id}` | — | missing | `lists.destroy`; client: `delete_vault_list` |
| POST | `/media/vault/lists/{list_id}/media` | — | missing | client: `add_media_to_vault_list` |
| DELETE | `/media/vault/lists/{list_id}/media` | — | missing | — |
| GET | `/media/vault/{media_id}` | `/vault/media/{mediaId}` | partial | `vault.show`; path differs (ours /vault/media/{id}); raw OF body (theirs wraps {data,_meta}) |

### Users & profile content (13)

yaml tags: Blocked / Restricted Users, Profile Content, Users

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/users/blocked` | — | missing | `users.blocked` |
| GET | `/users/list` | — | missing | `users.list`; client: `list_users` |
| GET | `/users/restricted` | — | missing | `users.restrict` |
| POST | `/users/{user_id}/block` | — | missing | client: `block_user` |
| DELETE | `/users/{user_id}/block` | — | missing | client: `unblock_user` |
| GET | `/users/{user_id}/labels` | — | missing | `profile-content.labels`; client: `user_labels_on` |
| GET | `/users/{user_id}/posts` | — | missing | `profile-content.posts`; client: `user_posts` |
| POST | `/users/{user_id}/restrict` | — | missing | client: `restrict_user` |
| DELETE | `/users/{user_id}/restrict` | — | missing | client: `unrestrict_user` |
| GET | `/users/{user_id}/stories/highlights` | — | missing | `profile-content.highlights`; client: `user_highlights` |
| POST | `/users/{user_id}/subscribe` | — | missing | client: `follow_user` |
| DELETE | `/users/{user_id}/subscribe` | — | missing | client: `unfollow_user` |
| GET | `/users/{username}` | — | missing | `users.show`; client: `get_user` |

### Fans (subscribers) & following (13)

yaml tags: Fans, Following

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/fans/active` | — | missing | client: `subscribers` |
| GET | `/fans/all` | — | missing | client: `subscribers` |
| GET | `/fans/expired` | — | missing | client: `subscribers` |
| GET | `/fans/latest` | — | missing | — |
| GET | `/fans/top` | — | missing | — |
| PUT | `/fans/{fan_id}/custom-name` | — | missing | client: `set_fan_custom_name` |
| GET | `/fans/{fan_id}/notes` | — | missing | — |
| PUT | `/fans/{fan_id}/notes` | — | missing | client: `set_fan_note` |
| DELETE | `/fans/{fan_id}/notes` | — | missing | — |
| GET | `/fans/{user_id}/subscriptions-history` | — | missing | — |
| GET | `/following/active` | — | missing | client: `following` |
| GET | `/following/all` | — | missing | client: `following` |
| GET | `/following/expired` | — | missing | client: `following` |

### Lists (11)

yaml tags: User List Collections

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/user-lists` | — | missing | `user-lists.index`; client: `get_lists` |
| POST | `/user-lists` | — | missing | `user-lists.store`; client: `create_list` |
| GET | `/user-lists/{userListId}` | — | missing | `user-lists.show`; client: `get_list` |
| PUT/PATCH | `/user-lists/{userListId}` | — | missing | `user-lists.update`; client: `rename_list` |
| DELETE | `/user-lists/{userListId}` | — | missing | `user-lists.destroy`; client: `delete_list` |
| GET | `/user-lists/{userListId}/users` | — | missing | client: `list_users_in` |
| POST | `/user-lists/{userListId}/users` | — | missing | client: `add_user_to_list (one user per call)` |
| DELETE | `/user-lists/{userListId}/users` | — | missing | — |
| GET | `/user-lists/{userListId}/users/pinned` | — | missing | `user-lists.pinned-users` |
| DELETE | `/user-lists/{userListId}/users/{userId}` | — | missing | `user-lists.remove-user`; client: `remove_user_from_list` |
| POST | `/user-lists/{userListId}/users/{userId}/pin` | — | missing | `user-lists.pin-or-unpin-user` |

### Stories & highlights (15)

yaml tags: Stories, Story Highlights

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/stories` | — | missing | `stories.index`; client: `my_stories` |
| POST | `/stories` | — | missing | `stories.store` |
| GET | `/stories/archive` | — | missing | `stories.index-archive`; client: `my_stories_archive` |
| GET | `/stories/highlights` | — | missing | `highlights.index` |
| POST | `/stories/highlights` | — | missing | `highlights.store` |
| GET | `/stories/highlights/{highlight_id}` | — | missing | `highlights.show` |
| PUT/PATCH | `/stories/highlights/{highlight_id}` | — | missing | `highlights.update` |
| DELETE | `/stories/highlights/{highlight_id}` | — | missing | `highlights.destroy` |
| PATCH | `/stories/highlights/{highlight_id}/{story_id}` | — | missing | `stories.highlights.add-story` |
| DELETE | `/stories/highlights/{highlight_id}/{story_id}` | — | missing | `stories.highlights.remove-story` |
| GET | `/stories/{story_id}` | — | missing | `stories.show` |
| DELETE | `/stories/{story_id}` | — | missing | `stories.destroy`; client: `delete_story` |
| POST | `/stories/{story_id}/mark-as-watched` | — | missing | `stories.mark-as-watched` |
| GET | `/stories/{story_id}/stats` | — | missing | `stories.stats` |
| GET | `/stories/{story_id}/viewers` | — | missing | `stories.viewers` |

### Statistics (6)

yaml tags: Statistics

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/statistics/overview` | — | missing | client: `my_stats_overview` |
| GET | `/statistics/reach/profile-visitors` | — | missing | — |
| GET | `/statistics/statements/earnings` | — | missing | — |
| GET | `/statistics/subscriber-metrics` | — | missing | — |
| GET | `/statistics/total-transactions` | — | missing | — |
| GET | `/subscribers/statistics` | — | missing | — |

### Earnings: transactions, payouts, chargebacks, banking (18)

yaml tags: Banking, Chargebacks, Payouts, Transactions

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/banking/available-payout-systems` | — | missing | — |
| GET | `/banking/countries` | — | missing | — |
| GET | `/banking/details/account-country` | — | missing | — |
| GET | `/banking/details/bank` | — | missing | `banking.` |
| GET | `/banking/details/dac7-form` | — | missing | — |
| GET | `/banking/details/legal-form` | — | missing | — |
| GET | `/banking/details/legal-info` | — | missing | — |
| GET | `/chargebacks` | — | missing | — |
| GET | `/chargebacks/ratio` | — | missing | client: `chargebacks_ratio` |
| GET | `/chargebacks/statistics` | — | missing | — |
| GET | `/payouts/balances` | — | missing | client: `payout_balances` |
| GET | `/payouts/earning-statistics` | — | missing | client: `earning_stats` |
| GET | `/payouts/eligibility` | — | missing | client: `payout_check_receive` |
| PATCH | `/payouts/payout-frequency` | — | missing | — |
| GET | `/payouts/payout-requests` | — | missing | client: `payout_requests` |
| POST | `/payouts/request-manual-withdrawal` | — | missing | — |
| GET | `/payouts/transactions` | — | missing | client: `transactions`; not in yaml |
| GET | `/transactions` | — | missing | `transactions.index`; client: `transactions` |

### Promotions & bundles (7)

yaml tags: Promotions, Subscription Bundles

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/bundles` | — | missing | `bundles.index`; client: `subscription_bundles` |
| POST | `/bundles` | — | missing | `bundles.store`; client: `create_bundle` |
| DELETE | `/bundles/{bundle_id}` | — | missing | `bundles.destroy`; client: `delete_bundle` |
| GET | `/promotions` | — | missing | `promotions.index`; client: `promotions` |
| POST | `/promotions` | — | missing | `promotions.store`; client: `create_promo` |
| DELETE | `/promotions/{promotion_id}` | — | missing | `promotions.destroy`; client: `delete_promo` |
| POST | `/promotions/{promotion_id}/stop` | — | missing | `promotions.stop` |

### Tracking & trial links (36)

yaml tags: Free Trial Links, Shared Free Trial Links, Shared Tracking Links, Stored Free Trial Links, Stored Shared Free Trial Links, Stored Shared Tracking Links, Stored Tracking Links, Tracking Links

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/shared-tracking-links` | — | missing | `shared-tracking-links.index` |
| DELETE | `/shared-tracking-links/{shared_tracking_link_id}` | — | missing | `shared-tracking-links.destroy` |
| GET | `/shared-tracking-links/{shared_tracking_link_id}/tags` | — | missing | `shared-tracking-links.tags.list` |
| POST | `/shared-tracking-links/{shared_tracking_link_id}/tags` | — | missing | `shared-tracking-links.tags.add` |
| DELETE | `/shared-tracking-links/{shared_tracking_link_id}/tags` | — | missing | `shared-tracking-links.tags.remove` |
| GET | `/shared-trial-links` | — | missing | `shared-trial-links.index` |
| DELETE | `/shared-trial-links/{shared_trial_link_id}` | — | missing | `shared-trial-links.destroy` |
| GET | `/shared-trial-links/{shared_trial_link_id}/tags` | — | missing | `shared-trial-links.tags.list` |
| POST | `/shared-trial-links/{shared_trial_link_id}/tags` | — | missing | `shared-trial-links.tags.add` |
| DELETE | `/shared-trial-links/{shared_trial_link_id}/tags` | — | missing | `shared-trial-links.tags.remove` |
| GET | `/stored/shared-tracking-links` | — | missing | `stored.shared-tracking-links.index` |
| GET | `/stored/shared-trial-links` | — | missing | `stored.shared-trial-links.index` |
| GET | `/stored/tracking-links` | — | missing | `stored.tracking-links.index` |
| GET | `/stored/trial-links` | — | missing | `stored.trial-links.index` |
| GET | `/tracking-links` | — | missing | `tracking-links.index`; client: `tracking_links` |
| POST | `/tracking-links` | — | missing | `tracking-links.store`; client: `create_tracking_link` |
| GET | `/tracking-links/{tracking_link_id}` | — | missing | `tracking-links.show` |
| DELETE | `/tracking-links/{tracking_link_id}` | — | missing | `tracking-links.destroy`; client: `delete_tracking_link` |
| GET | `/tracking-links/{tracking_link_id}/cohort-arps` | — | missing | `tracking-links.cohort-arps` |
| GET | `/tracking-links/{tracking_link_id}/spenders` | — | missing | `tracking-links.spenders` |
| GET | `/tracking-links/{tracking_link_id}/stats` | — | missing | `tracking-links.stats` |
| GET | `/tracking-links/{tracking_link_id}/subscribers` | — | missing | `tracking-links.subscribers` |
| GET | `/tracking-links/{tracking_link_id}/tags` | — | missing | `tracking-links.tags.list` |
| POST | `/tracking-links/{tracking_link_id}/tags` | — | missing | `tracking-links.tags.add` |
| DELETE | `/tracking-links/{tracking_link_id}/tags` | — | missing | `tracking-links.tags.remove` |
| GET | `/trial-links` | — | missing | `trial-links.index`; client: `trial_links` |
| POST | `/trial-links` | — | missing | `trial-links.store`; client: `create_trial_link` |
| GET | `/trial-links/{trial_link_id}` | — | missing | `trial-links.show` |
| DELETE | `/trial-links/{trial_link_id}` | — | missing | `trial-links.destroy`; client: `delete_trial_link` |
| GET | `/trial-links/{trial_link_id}/cohort-arps` | — | missing | `trial-links.cohort-arps` |
| GET | `/trial-links/{trial_link_id}/spenders` | — | missing | `trial-links.spenders` |
| GET | `/trial-links/{trial_link_id}/stats` | — | missing | `trial-links.stats` |
| GET | `/trial-links/{trial_link_id}/subscribers` | — | missing | `trial-links.subscribers` |
| GET | `/trial-links/{trial_link_id}/tags` | — | missing | `trial-links.tags.list` |
| POST | `/trial-links/{trial_link_id}/tags` | — | missing | `trial-links.tags.add` |
| DELETE | `/trial-links/{trial_link_id}/tags` | — | missing | `trial-links.tags.remove` |

### Notifications (6)

yaml tags: Notifications

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/notifications` | — | missing | `notifications.`; client: `notifications` |
| GET | `/notifications/counts` | — | missing | client: `notifications_count` |
| POST | `/notifications/mark-all-as-read` | — | missing | — |
| GET | `/notifications/search-users` | — | missing | — |
| GET | `/notifications/tabs-order` | — | missing | client: `notification_tabs_order` |
| PUT | `/notifications/tabs-order` | — | missing | — |

### Settings (16)

yaml tags: Settings

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/settings` | — | missing | `settings.`; client: `my_settings` |
| GET | `/settings/blocked-countries` | — | missing | — |
| PUT | `/settings/blocked-countries` | — | missing | — |
| GET | `/settings/drm` | — | missing | — |
| PATCH | `/settings/drm` | — | missing | — |
| POST | `/settings/profile` | — | missing | client: `update_profile` |
| GET | `/settings/social-media-buttons` | — | missing | `settings.social-media-buttons.index` |
| POST | `/settings/social-media-buttons` | — | missing | `settings.social-media-buttons.store` |
| POST | `/settings/social-media-buttons/reorder` | — | missing | — |
| PUT/PATCH | `/settings/social-media-buttons/{button_id}` | — | missing | `settings.social-media-buttons.update` |
| DELETE | `/settings/social-media-buttons/{button_id}` | — | missing | `settings.social-media-buttons.destroy` |
| PATCH | `/settings/subscription-price` | — | missing | — |
| POST | `/settings/username-exists` | — | missing | — |
| GET | `/settings/welcome-message` | — | missing | client: `message_templates` |
| POST | `/settings/welcome-message` | — | missing | client: `upsert_welcome_template` |
| PATCH | `/settings/welcome-message` | — | missing | client: `upsert_welcome_template` |

### Release forms (7)

yaml tags: Release Forms

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/release-forms` | — | missing | `release-forms.index` |
| POST | `/release-forms/create-invitation-link` | — | missing | `release-forms.create-invitation-link` |
| POST | `/release-forms/create-release-form` | — | missing | `release-forms.create-release-form` |
| GET | `/release-forms/mentions` | — | missing | `release-forms.mentions` |
| PATCH | `/release-forms/rename` | — | missing | `release-forms.rename` |
| GET | `/release-forms/taggable-users` | — | missing | `release-forms.taggable-users` |
| PATCH | `/release-forms/toggle-show` | — | missing | `release-forms.toggle-show` |

### Giphy (2)

yaml tags: Giphy

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/giphy/search` | — | missing | `giphy.search`; client: `gif_search` |
| GET | `/giphy/trending` | — | missing | `giphy.trending`; client: `gif_trending` |

### Undocumented (route table only, no yaml tag) (1)

| Method | onlyfansapi path (api/{account}/...) | Our path (/v1/{account}/...) or — | Status | Note |
|---|---|---|---|---|
| GET | `/workflows/account-performance/starting-revenues` | — | missing | not in yaml |

## B. Non-account routes

Our paths are absolute. Analytics rows: the nearest thing we have is `GET /v1/stats` (event-ledger totals), a different shape, so they are counted missing. Their API-key management has no `api/api-keys*` routes: it is dashboard-only (`team/{team}/api-keys` web routes, 4), see D.

### Accounts & connect (10)

| Method | onlyfansapi path | Our path or — | Status | Note |
|---|---|---|---|---|
| GET | `api/accounts` | `/v1/accounts` | partial | `accounts.index`; theirs bare array of {id acct_xxx, onlyfans_id, onlyfans_username, onlyfans_email, is_authenticated, authentication_progress, display_name, onlyfans_user_data}, query onlyfans_id/onlyfans_username/onlyfans_email; ours {items:[{id:int,label,username,displayName,avatarUrl,status}]} |
| DELETE | `api/accounts/{account}` | — | missing | `accounts.destroy` |
| PUT/PATCH | `api/accounts/{account}` | — | missing | `accounts.update`; not in yaml |
| POST | `api/authenticate` | — | missing | `authenticate.store`; upstream has operator-only `POST /session/bootstrap` (curl paste, ~ their auth_type raw_data); not exposed by the gateway |
| PUT | `api/authenticate/{account_id}/credentials` | — | missing | `authenticate.update-credentials` |
| POST | `api/authenticate/{account_id}/reauthenticate` | — | missing | `authenticate.reauthenticate` |
| GET | `api/authenticate/{attempt_id}` | — | missing | `authenticate.show` |
| PUT | `api/authenticate/{attempt_id}` | — | missing | `authenticate.update` |
| POST | `api/authenticate/{attempt_id}/send-email-to-creator` | — | missing | `authenticate.send-otp-email-to-creator` |
| POST | `api/client-sessions` | — | missing | — |

### Key identity (1)

| Method | onlyfansapi path | Our path or — | Status | Note |
|---|---|---|---|---|
| GET | `api/whoami` | `/v1/whoami` | partial | theirs {api_key, team}; ours {team{id,name,slug,linked}, key{id,name,scope,allowedAccountIds}} |

### Webhooks (9)

| Method | onlyfansapi path | Our path or — | Status | Note |
|---|---|---|---|---|
| GET | `api/webhooks` | `/v1/webhooks` | partial | `webhooks.index`; theirs {data:[{id,url,events,has_signing_secret,enabled,created_at}],_meta}; ours {items:[{id,url,description,events,secret?,enabled,pausedReason,consecutiveFailures,createdAt,updatedAt}]} |
| POST | `api/webhooks` | `/v1/webhooks` | partial | `webhooks.store`; body theirs endpoint_url, signing_secret (caller-chosen, optional), events, account_scope, account_ids; ours url, description, events (secret server-generated whsec_) |
| GET | `api/webhooks/events` | `/v1/webhooks/events` | partial | theirs data[{value,description}] with their event names; ours items[{type,description}], different names (see C) |
| GET | `api/webhooks/{webhookEventType}/example-payload` | — | missing | not in yaml |
| DELETE | `api/webhooks/{webhook_id}` | `/v1/webhooks/:id` | have | `webhooks.destroy` |
| GET | `api/webhooks/{webhook_id}` | `/v1/webhooks/:id` | partial | `webhooks.show`; same field differences as list |
| PUT/PATCH | `api/webhooks/{webhook_id}` | `/v1/webhooks/:id (PATCH only)` | partial | `webhooks.update`; body theirs endpoint_url/events/enabled/account_scope/account_ids; ours url/description/events/enabled; no PUT |
| GET | `api/webhooks/{webhook_id}/deliveries` | `/v1/webhooks/:id/deliveries` | partial | `webhooks.deliveries.index`; query theirs date_start,date_end,event,succeeded,limit,offset; ours status,event,cursor,limit; theirs one record per attempt (delivery_uuid groups), ours one per delivery |
| POST | `api/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver` | `/v1/webhooks/:id/deliveries/:deliveryId/redeliver` | partial | `webhooks.deliveries.redeliver`; theirs {data:{redelivery_id,delivery_id,webhook_id,event,idempotency_key,url,queued_at}}; ours 202 {delivery}; theirs keeps idempotency key, ours issues a new webhook-id |

### Analytics (cross-account) (8)

| Method | onlyfansapi path | Our path or — | Status | Note |
|---|---|---|---|---|
| POST | `api/analytics/financial/forecast` | — | missing | `analytics.financial.forecast` |
| POST | `api/analytics/financial/profitability` | — | missing | `analytics.financial.profitability` |
| GET | `api/analytics/financial/profitability/{account}/history` | — | missing | `analytics.financial.profitability.history` |
| POST | `api/analytics/financial/transactions/by-type` | — | missing | `analytics.financial.transactions.by-type` |
| POST | `api/analytics/financial/transactions/summary` | — | missing | `analytics.financial.transactions.summary` |
| POST | `api/analytics/summary/comparison` | — | missing | `analytics.summary.comparison` |
| POST | `api/analytics/summary/earnings` | — | missing | `analytics.summary.earnings` |
| POST | `api/analytics/summary/historical` | — | missing | `analytics.summary.historical` |

### Lookups & misc (4)

| Method | onlyfansapi path | Our path or — | Status | Note |
|---|---|---|---|---|
| GET | `api/banned-words` | — | missing | `banned-words.index` |
| GET | `api/link-tags` | — | missing | `link-tags.index` |
| GET | `api/profiles/{username}` | — | missing | `profiles.show`; client: `get_user` (per account) |
| GET | `api/search` | — | missing | client: `search_users` (per account) |

### B.1 Ours only (no counterpart in their `api/` table)

- `GET /v1/ws` (client WebSocket event stream), `GET /v1/stats` (event-ledger stats), `POST /v1/webhooks/:id/test` (no webhook test route in their `api/` table).
- Dashboard/ops, session-authenticated, not part of the parity surface: `GET|POST /api/keys`, `PATCH|DELETE /api/keys/:id`, `GET /api/logs`, `GET /api/logs/:id`, `GET /api/usage`, `GET /api/overview`, `GET|POST /api/auth/*`, `GET /healthz`, `GET /openapi.json`, `GET /docs`.
- Upstream operator surface (never forwarded): `GET /of-accounts`, `POST /session/bootstrap`, `GET /ws` (event socket the gateway consumes).

## C. Webhook events

72 events in `examplePayloads` = 34 OnlyFans + 38 Fansly. Documented OnlyFans events: 34 (the docs page, the reference md and the `event-groups` asset all list the same 34; there is no 36th). In scope: 34 minus 7 `data_exports.*` minus `fan_summary.completed` = 26, all documented. Payload keys are the payload's top-level keys with generic types; `name{n}` = object with n keys, `name[{n}]` = array of n-key objects (defined in C.2). Every in-scope event's envelope carries `account_id` (string, `acct_xxx`).

| Event | Documented (y/n) | In examplePayloads (y/n) | Payload keys (generic) | Our event or — | Status |
|---|---|---|---|---|---|
| `messages.received` | y | y | responseType:string, text:string, giphyId:null, lockedText:bool, isFree:bool, price:int, isMediaReady:bool, mediaCount:int, media:[], previews:[], isTip:bool, isReportedByMe:bool, isCouplePeopleMedia:bool, queueId:int, isMarkdownDisabled:bool, fanData{3}, fromUser{42}, isFromQueue:bool, id:int, isOpened:bool, isNew:bool, createdAt:string, changedAt:string, cancelSeconds:int, isLiked:bool, canPurchase:bool, canPurchaseReason:string, canReport:bool, canBePinned:bool, isPinned:bool, replyToMessage{32} | `message.received` | partial: name differs; ours data {messageId, fanId, text, price, mediaCount} vs full OF message object |
| `messages.sent` | y | y | responseType:string, text:string, giphyId:null, lockedText:bool, isFree:bool, price:int, isMediaReady:bool, mediaCount:int, media[{12}], previews:[], isTip:bool, isReportedByMe:bool, isCouplePeopleMedia:bool, queueId:int, isMarkdownDisabled:bool, releaseForms:[], isFromQueue:bool, id:int, isOpened:bool, isNew:bool, createdAt:string, changedAt:string, cancelSeconds:int, isLiked:bool, canPurchase:bool, canPurchaseReason:string, canReport:bool, canBePinned:bool, isPinned:bool, toUser{42} | `message.sent` | partial: name differs; same reduced data as message.received |
| `messages.ppv.unlocked` | y | y | id:string, type:string, createdAt:string, text:string, replacePairs{3}, subType:string, user_id:string, isRead:bool, canGoToProfile:bool, user{36} | `ppv.unlocked` (TBC) | missing: catalogued, never emitted |
| `messages.deleted` | y | y | id:string | — | missing |
| `messages.liked` | y | y | id:string | — | missing |
| `messages.unliked` | y | y | id:string | — | missing |
| `chat_queue.updated` | y | y | id:int, date:string, canUnsend:bool, hasError:bool, isCanceled:bool, isCouplePeopleMedia:bool, isDone:bool, isReady:bool, pending:int, total:int, unsendSeconds:int | — | missing |
| `chat_queue.finished` | y | y | id:int, date:string, canUnsend:bool, hasError:bool, isCanceled:bool, isCouplePeopleMedia:bool, isDone:bool, isReady:bool, pending:int, total:int, unsendSeconds:int | — | missing |
| `subscriptions.new` | y | y | id:string, type:string, createdAt:string, text:string, replacePairs{2}, subType:string, user_id:string, isRead:bool, canGoToProfile:bool, user{36} | `subscription.new` (TBC) | missing: catalogued, never emitted |
| `subscriptions.renewed` | y | y | id:string, type:string, createdAt:string, text:string, replacePairs{2}, subType:string, user_id:string, isRead:bool, canGoToProfile:bool, user{36} | `subscription.renewed` (TBC) | missing: catalogued, never emitted |
| `subscriptions.expired` | y | y | id:string, type:string, subType:string, createdAt:string, expiredAt:string, user_id:string, user{36}, fanData{4} | `subscription.expired` (TBC) | missing: catalogued, never emitted |
| `users.typing` | y | y | id:int | — | missing |
| `users.online` | y | y | fan{5}, observed_at:string, status_changed_at:string, last_seen_online_at:string | — | missing |
| `users.offline` | y | y | fan{5}, observed_at:string, status_changed_at:string, last_seen_online_at:string | — | missing |
| `posts.liked` | y | y | id:string, type:string, createdAt:string, text:string, replacePairs{1}, subType:string, user_id:string, isRead:bool, canGoToProfile:bool, user{36} | — | missing |
| `tips.received` | y | y | amountGross:int, amountNet:int, fanData{3}, id:string, type:string, createdAt:string, text:string, replacePairs{4}, subType:string, user_id:string, isRead:bool, canGoToProfile:bool, user{36} | `tip.received` (TBC) | missing: catalogued, never emitted |
| `transactions.new` | y | y | id:string, created_at:string, type:string, amount:int, vat_amount:number, tax_amount:int, net_amount:number, fee_amount:number, currency:string, description:string, fanData{3} | — | missing |
| `accounts.connected` | y | y | state:string, progress:string, latestAuthAttempt{7} | — | missing |
| `accounts.reconnected` | y | y | state:string, progress:string, latestAuthAttempt{7} | — | missing |
| `accounts.disconnected` | y | y | account_id:string, onlyfans_id:string, onlyfans_username:string, disconnected_at:string | — | missing |
| `accounts.session_expired` | y | y | state:string, progress:string, latestAuthAttempt{7} | `account.session_expired` | partial: name differs; ours data {} vs {state, progress, latestAuthAttempt} |
| `accounts.authentication_failed` | y | y | state:string, progress:string, latestAuthAttempt{7} | — | missing |
| `accounts.otp_code_required` | y | y | state:string, progress:string, latestAuthAttempt{7} | — | missing |
| `accounts.face_otp_required` | y | y | state:string, progress:string, face_otp_verification_url:string, latestAuthAttempt{7} | — | missing |
| `media_uploads.completed` | y | y | id:string, prefixed_id:string, account_id:string, status:string, file_name:string, created_at:string, media_id:int, media{11}, credits_used:int, completed_at:string | — | missing |
| `media_uploads.failed` | y | y | id:string, prefixed_id:string, account_id:string, status:string, file_name:string, created_at:string, error:string, failed_at:string | — | missing |

Ours only: `post.expired` (`{postId}`), `webhook.test` (`{message}`), `upstream.*` (any other OnlyFans socket frame passed through raw as `upstream.<key>`; some of the missing events above, e.g. typing or tips, may already arrive this way, unmapped). Events reach every endpoint of every linked workspace: there is no per-account event filtering.

### C.2 Nested payload objects (generic)

- fanData (messages.received, tips.received, transactions.new): `{available: bool, last_updated_at: string, spending: {total: int, messages: int, subscribes: int, posts: int, tips: int, streams: int}}`
- fanData (subscriptions.expired): `{available: bool, last_updated_at: string, spending: {total: number, messages: number, subscribes: number, posts: int, tips: int, streams: int}, previous_reply_at: string}`
- latestAuthAttempt (accounts.*): `{started_at: string, completed_at: null, success: bool, error_message: null, needs_otp: bool, needs_face_otp: bool, otp_phone_ending: null}`
- fan (users.online/offline): `{id: string, username: string, name: string, display_name: null, spending: {messages: int, subscribes: int, posts: int, tips: int, streams: int, total: int}}`
- media[] item (messages.sent): `{id: int, type: string, convertedToVideo: bool, canView: bool, hasError: bool, createdAt: string, isReady: bool, files: {full: {url: string, width: int, height: int, size: int, sources: []}, thumb: {url: string, width: int, height: int, size: int}, preview: {url: string, width: int, height: int, size: int}, squarePreview: {url: string, width: int, height: int, size: int}}, duration: int, releaseForms: [], hasCustomPreview: bool, videoSources: {<id>: null}}`
- media (media_uploads.completed): `{id: int, type: string, convertedToVideo: bool, canView: bool, hasError: bool, createdAt: string, isReady: bool, files: {full: {url: null, width: int, height: int, size: int, sources: []}, thumb: null, preview: null, squarePreview: null}, duration: int, releaseForms: [], hasCustomPreview: bool}`
- replacePairs (messages.ppv.unlocked): `{{NAME}: string, {MESSAGE_LINK}: string, {AMOUNT}: string}`
- replacePairs (subscriptions.new/renewed): `{{SUBSCRIBER_LINK}: string, {PRICE}: string}`
- replacePairs (tips.received): `{{SUBSCRIBER_LINK}: string, {AMOUNT}: string, {POST_BLOCK}: string, {POST_DATA}: string}`
- replacePairs (posts.liked): `{{POST_LINK}: string}`
- replyToMessage (messages.received): same shape as the messages.received payload itself (nested message incl. fromUser)
- fromUser (messages.received), OF user object, 42 keys: view, avatar, avatarThumbs, header, headerSize, headerThumbs, id, name, username, canLookStory, canCommentStory, hasNotViewedStory, isVerified, canPayInternal, hasScheduledStream, hasStream, hasStories, tipsEnabled, tipsTextEnabled, tipsMin, tipsMinInternal, tipsMax, canEarn, canAddSubscriber, subscribePrice, displayName, notice, isRestricted, canRestrict, subscribedBy, subscribedByExpire, subscribedByExpireDate, subscribedByAutoprolong, subscribedIsExpiredNow, currentSubscribePrice, subscribedOn, subscribedOnExpiredNow, subscribedOnDuration, listsStates, showMediaCount, lastSeen, canReport
- user (ppv/subscriptions/tips/posts.liked), OF user object, 36 keys: avatar, avatarThumbs, header, headerSize, headerThumbs, id, name, username, canLookStory, canCommentStory, hasNotViewedStory, isVerified, canPayInternal, hasScheduledStream, hasStream, hasStories, tipsEnabled, tipsTextEnabled, tipsMin, tipsMinInternal, tipsMax, canEarn, canAddSubscriber, subscribePrice, subscribedBy, subscribedOn, canReceiveChatMessage, hideChat, lastSeen, isPerformer, isRealPerformer, view, canReport, subscribedByData, subscribedOnData, isBlocked

## D. Envelope, signing, webhook config, key model

### D.1 Their documented signing (docs.onlyfansapi.com/webhooks/protecting-your-webhooks + delivery-and-retries)

- Header `Signature`, sent only when the webhook has a signing secret (the secret is optional and chosen by the caller).
- Value: hex HMAC-SHA256 with the signing secret's UTF-8 bytes as key, over the raw JSON request body. No timestamp, no version prefix, no message id in the signed string.
- Other headers: `Content-Type: application/json`, `User-Agent: OnlyFansAPI.com/Webhook-Client`, `X-OFAPI-Idempotency-Key` (stable per event, kept on redelivery; absent for `users.typing/online/offline`), `X-OFAPI-Redelivery-Of` (manual redelivery only).
- **Verdict: ours does not match.** Ours is Standard Webhooks: headers `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`; HMAC-SHA256 keyed with the base64-decoded part of a server-generated `whsec_` secret, over `<webhook-id>.<webhook-timestamp>.<body>`; 300 s tolerance (`apps/api/src/lib/signature.ts`, `docs/webhooks.md`). Header name, signed string, key derivation, digest encoding and the timestamp all differ, so a receiver written for one cannot verify the other.

### D.2 Side by side

| Aspect | Theirs | Ours |
|---|---|---|
| Envelope | `{"event": string, "account_id": "acct_xxx", "payload": {...}}`; `account_id` omitted for `data_exports.*` and `fan_summary.completed` | `{"id": "whd_xxx", "type", "createdAt", "accountId": int or null, "data": {...}}` |
| Event names | plural resource, e.g. `messages.received`, `subscriptions.new`, `accounts.session_expired` | singular, e.g. `message.received`, `subscription.new`, `account.session_expired` |
| Dedup key | `X-OFAPI-Idempotency-Key`, same across retries and redeliveries | `webhook-id` = delivery id; a redelivery gets a new id (`replayOf` set) |
| Attempts | 3 total: immediately, ~10 s, ~100 s; 404/410 stops retrying | `WEBHOOK_MAX_ATTEMPTS` 6, backoff 30 s, 2 m, 10 m, 1 h, 6 h |
| Timeouts | 5 s connect, 10 s total; 3xx is a failure | 10 s total; `redirect: manual` |
| Breaker | pause after 20 consecutive failed deliveries; probe after 5 min, doubling to 6 h; disable+enable clears it | pause after `WEBHOOK_PAUSE_AFTER` 20; no probe, `enabled: true` clears it |
| Retention | 7 days, one record per attempt (`delivery_uuid` groups them) | `WEBHOOK_RETENTION_DAYS` 7, one record per delivery with an `attempts` counter |
| Paused endpoint | events dropped, not redeliverable | events dropped |
| Config fields | `endpoint_url`, `signing_secret` (optional, write-only; read back as `has_signing_secret`), `events[]`, `enabled`, `account_scope` global/inclusive/exclusive, `account_ids[]` | `url` (https unless `ALLOW_HTTP_WEBHOOKS`), `description`, `events[]` (empty = all; max 50), `enabled`; secret generated server-side and returned as `secret`; no account scoping |

### D.3 API key model

| Aspect | Theirs | Ours |
|---|---|---|
| Auth | Bearer key | Bearer key (`Authorization`), or dashboard session |
| Permission | `permission_level` read / read_write / read_write_delete (form default read_write_delete) | `scope` read / write (default read); write covers every non-GET/HEAD method, DELETE included (`assertWriteScope`) |
| Account scope | `account_scope` global / inclusive / exclusive + `account_ids` | `allowedAccountIds` (null = all), equivalent to global or inclusive only; no exclusive |
| Other | `expires_at`, `ip_allowlist`, `status`, `last_used_at`, key `preview` | none of these |
| Management | dashboard web routes only (`team/{team}/api-keys` index/store/update/destroy); `GET api/whoami` is the only key API | dashboard routes `/api/keys` (session-authenticated); `GET /v1/whoami` |

### D.4 Pagination key

Confirmed from the yaml (2026-10-02): `_pagination` appears on 34 operations. In 33 of them it is `{"next_page": string}`, where the string is the absolute URL of the next page, or null on the last page in some examples; one operation uses `next_cursor` / `next_page_url` / `total_results` instead, and 5 also carry a `notice` string. v5's wrapper emits `{"next_page": "<absolute URL>"}`, built from our base URL and the next page's query, only when there is a next page (plan-v5 §2.2).

## E. yaml vs route table disagreements

1. Route table only (not in yaml), public prefixes: `GET api/{account}/session` (`account-session.show`), `GET api/{account}/payouts/transactions`, `GET api/{account}/workflows/account-performance/starting-revenues`, `GET api/webhooks/{webhookEventType}/example-payload`, `PUT|PATCH api/accounts/{account}` (`accounts.update`; yaml documents only DELETE on that path), `ANY api/{account}/_of/{path?}` (see G). Out of scope: `GET api/smart-links/resolve-profile`, `POST api/webhooks/coingate`, `POST api/webhooks/vatstack`. All `api/_internal/*`, `api/_auth_app/*` and `api/fansly/*` routes are route-table only as well.
2. yaml only: `PUT /api/smart-links/{smart_link_id}` (route table has GET and DELETE only; out of scope). The other 297 yaml operations all exist in the route table.
3. Methods: the route table registers `PUT|PATCH` where the yaml documents `PUT` only on `api/webhooks/{webhook_id}`, `mass-messaging/{id}`, `media/vault/lists/{list_id}`, `posts/{post_id}`, `settings/social-media-buttons/{button_id}`, `stories/highlights/{highlight_id}`, `user-lists/{userListId}` (and out-of-scope `api/fan-summary-categories/{category_id}`). Per the rule, these rows are `PUT/PATCH`.
4. Path parameter names: `api/accounts/{id}` (yaml) vs `{account}` (table); `api/{account}/mass-messaging/{id}` vs `{mass_messaging}`. Rows use the route-table names.
5. Tags: yaml files `GET /api/whoami` under "API Keys" though no API-key routes exist; 3 route-table-only per-account routes have no tag (grouped by path segment in A).
6. Brief vs sources: the brief expected 36 documented events; every source has 34. The brief listed `api/api-keys*` as non-account routes; none exist under `api/`.

## F. Out of scope, no rows

| Group | Routes excluded | Events excluded |
|---|---|---|
| Fansly | 89 (`api/fansly/*`) | 38 (`fansly.*`) |
| Fanvue | 0 found | 0 found |
| Smart Links | 24 (`api/smart-links*` 19 incl. `resolve-profile`; `api/smart-link-postbacks*` 5) | 0 |
| FansBot | 20 (`api/_internal/fansbot/*` 19, `api/_internal/mastra/*` 1) | 0 |
| Data exports | 6 (`api/data-exports*`) | 7 (`data_exports.*`) |
| AI features | 7 (`api/fan-summary-categories*` 4, `api/{account}/fans/{fan_id}/summary` GET+POST 2, `api/ai-voice-messages/stats` 1) | 1 (`fan_summary.completed`) |
| Billing | 3 (`api/webhooks/coingate`, `api/webhooks/vatstack` payment-provider callbacks; `api/usage/credits`, their credit metering) | 0 |
| Internal infrastructure (added: not public API) | 30 (`api/_internal/*` other than FansBot 27: viktor 11, media-downloads 7, auth-attempts 3, websockets 3, proxy 1, fans-pixel-interests 1, daily-registration-result 1; `api/_auth_app/*` 3) | 0 |
| Raw passthrough | 1 (`api/{account}/_of/{path?}`, section G) | 0 |
| **Total** | **180** (445 = 265 in scope + 180) | **46** (72 = 26 + 46) |

## G. Raw passthrough

Theirs `ANY api/{account}/_of/{path?}` (GET/POST/PUT/PATCH/DELETE/OPTIONS; auto-named, not in yaml, so the mapping of `{path}` onto OnlyFans is undocumented) → proposed ours `ANY /v1/{account}/_of/{path}` → upstream `/of/_of/{path}`. The gateway half already works: `ALL /v1/:account/*` (`apps/api/src/modules/proxy/routes.ts`) forwards any method, the query and a JSON body verbatim to upstream `/of/<rest>` after the write-scope and account-allowlist checks, rejecting encoded separators and dot segments. The upstream half does not exist: `services/upstream` has no `_of` route and no generic forwarder; its `/of` APIRouter (`app.py`) registers exactly the 8 named routes in A, and everything else 404s. The building block exists: `OFClient.request(self, method: str, path_or_url: str, *, json_body: dict | None = None, params: dict | None = None) -> requests.Response` (`of_client.py`; signed, any of GET/POST/PUT/PATCH/DELETE; OnlyFans signing is body-independent), plus `request_json(method, path_or_url, **kw)` that raises `OFAPIError` on non-2xx. Note: `_build_url` treats any `path_or_url` starting with `http` as a full URL, so the forwarder must pin the path under `/api2/v2/`. Excluded from all counts above.
