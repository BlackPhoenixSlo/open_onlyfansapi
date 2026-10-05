# OF socket frames mapped to the reference webhook events (2026-10-05)

Follow-up to the plan-v6 capture kit §(c). The owner produced no per-row devtools captures (`~/of-captures/` does
not exist), so **the 72 HTTP `?` rows of the kit stay open**: nothing below maps an HTTP row. What exists is a log of
inbound OnlyFans WebSocket frames; this document maps those frames to the reference API's webhook events (plan-v5
inventory §C, whose status column is as of 2026-10-02; the live status is `docs/webhooks.md`).

**Rule used.** plan-v6 §1.2 governs routes: "An unverified PATH may ship; an unverified BODY or value mapping may
not", and a body field ships only where `of_client.py` marks it VERIFIED or CONFIRMED live (the kit sums this up as
"a write needs its body and effect seen once"). §1.2 says nothing about events. Applying it to socket frames is this
document's own decision: **an event ships when a captured frame shows the key, its value shape and that the
reference event's meaning holds for it**. A frame whose meaning rests on a case never observed is a *candidate*.

Privacy (plan-v6 §2.5): only key names, JSON types, nesting, presence counts and counts of relations between frames
were read from the capture. No id, name, text, URL, amount or other value is recorded here, in the fixtures or in
the tests; fixtures are synthetic (`services/upstream/tests/fixtures/`).

## 1. Provenance

- File: `~/of-capture/of-capture-2026-10-02.jsonl`, outside the repo (not copied or moved). Written by a local tailer
  that is not in the repo, for one connected account, from 2026-10-02 (file name) to 2026-10-05. The tailer was
  still appending while this was written; the counts below are the 5,518-frame snapshot that was analysed.
- 5,518 inbound frames, one raw JSON object per line (no wrapper, no receive time). No outbound frames were logged,
  so `users.typing` (plan-v5 #28) cannot be answered from it.
- Frame key sets and counts:

| Keys in the frame | Frames |
|---|---|
| `post_published` | 2044 |
| `post_expire` | 1441 |
| `post_updated` | 1287 |
| `chat_messages`, `count_priority_chat`, `count_call_request_chat`, `unread_tips` | 271 |
| `api2_chat_message` | 268 |
| `stories` | 147 |
| `post_fundraising_updated` | 25 |
| `hasSystemNotifications`, `messages` | 9 |
| `toasts` | 9 |
| `newTagsCount` | 6 |
| `story_tips` | 5 |
| `hasSystemNotifications`, `new_message` | 4 |
| `connected`, `v` | 1 |
| `chat_message_delete` | 1 |

**The account was subscriber-side; no own events were observed.** Checked against the session's user id in memory:
none of the messages was sent by the account, and none of the posts, stories or story tips was its own. Every
statement below about frame contents holds for a subscriber-side account; creator-side frames are unverified.

## 2. Mapping

Status: **ships** = `events.classify` emits it; **candidate** = probably maps, not shipped (§2.1); **no
counterpart** = the reference API has no OnlyFans event for it, so it stays `upstream.<key>` (raw); **noise** =
dropped (logged once per key).

| Frame key | Reference event | Status | Notes |
|---|---|---|---|
| `api2_chat_message` | `messages.received` / `messages.sent` | ships (since v4) | All received. `messages.sent` not observed. |
| `chat_message_delete` | `messages.deleted` | **ships (new)** | Value: the message id as a digit string. Payload `{id}` (string) is the whole reference example. Frame id `message.deleted:<account>:<message>`. A value that is not an id stays `upstream.chat_message_delete`. |
| `story_tips` | `tips.received` | candidate | Stays `upstream.story_tips`. §2.1. |
| `post_expire` | none (ours: `posts.expired`) | ships (since v4) | Fires for other creators' posts in the feed (§4). |
| `post_published`, `post_updated`, `post_fundraising_updated` | none | no counterpart | The reference has post events for Fansly only. |
| `stories` | none | no counterpart | |
| `new_message` | none | no counterpart | OF notification object, same shape as the reference's notification-based payloads; its `type`/`subType` match none of theirs (compared, not recorded). |
| `toasts` | none | no counterpart | UI toasts. |
| `chat_messages`, `count_priority_chat`, `count_call_request_chat`, `unread_tips`, `newTagsCount` | none | noise | Counter-only frames. |
| `hasSystemNotifications`, `messages` | none | noise (**new**) | A bool and an int in one frame: counter-only now that flags count. Were `upstream.hasSystemNotifications` / `upstream.messages`. Alongside a non-counter key (`new_message`) they still pass through. |
| `connected`, `v` | none | noise | Handshake. |

**Reference events still unobserved after 3 days:** `messages.sent`, `messages.ppv.unlocked`, `messages.liked`,
`messages.unliked`, `chat_queue.updated`, `chat_queue.finished`, `subscriptions.new`, `subscriptions.renewed`,
`subscriptions.expired`, `users.typing`, `users.online`, `users.offline` (no `online_status` frame), `posts.liked`,
`tips.received`, `transactions.new`. These stay TBC. `accounts.*` and `media_uploads.*` have no socket source
(plan-v5 §1.9).

### 2.1 `story_tips` → `tips.received` (candidate, not shipped)

- Every observed frame was a tip on another creator's story by another user. A tip on the account's own story (the
  only case that would be `tips.received`) was never observed.
- `amount` matched the number in `amount_human` in every frame, but whether it is whole dollars in general, and gross
  or net, is unproven.
- The reference builds `tips.received` from an OF notification object; a tip may also arrive as a notification frame
  (like `new_message`). Mapping both would count one tip twice in `/v1/stats`.
- Against the reference example it could supply `amountGross`, `id`, `user_id` and `user.{id,name,avatar}`; not
  `amountNet`, `type`, `createdAt`, `text`, `replacePairs`, `subType`, `isRead`, `canGoToProfile` or 33 of the 36
  `user` keys.

### 2.2 What `messages.received` supplies (subscriber-side)

Every reference key except `replyToMessage` (never present), with the reference's full 42-key `fromUser` (`notice`
in about a third of frames) plus `isActive`, `isDeleted`, `isPaywallRequired`, `subscribedOnExpire` and
`subscriptionBundles` (optional). Top-level OF extras: `canUnsendQueue`, `unsendSecondsQueue` (almost always),
`isAddedToBookmarks`, `chatUserId`. `fanData` is the gateway's own (`available: false`), not from the frame. The test
frames in `of_frames/` predate this and keep a 2-key `fromUser`.

## 3. Key structures (names and types only)

Shipped or candidate:

```
chat_message_delete: string
story_tips: {id: int, from_user: {id: int, name: string, avatar: string}, story_user_id: int, story_id: int,
  amount: int, amount_human: string, message: string|null}
post_expire: string
api2_chat_message: the reference messages.received keys (§2.2), price: int|number, previews: [int],
  media: [{id: int, type: string, convertedToVideo, canView, hasError, isReady: bool, createdAt: null,
  files: {full, thumb, preview, squarePreview: object}, duration: int, hasCustomPreview: bool (optional),
  videoSources: {<id>: string|null} (optional)}]
```

The rest, one line each:

```
post_published: {id: string, user_id: string, show_posts_in_feed: bool, counters: {7 ints}}
post_updated: string
post_fundraising_updated: {id: int, fundRaising: {target: int, targetProgress: int|number, presets: [string]}}
stories: [ {id, userId: int, media: [media], createdAt: string, question, post (rare), texts (optional), flags} ]
new_message: {id, type, createdAt, text, subType, user_id: string, replacePairs: {{USER_LINK}, {TEXT}},
  isRead, canGoToProfile: bool, newPrice: null, user: {the reference notification user's 36 keys + 3}}
toasts: [ {id: int, title, text, type: string, data: {code, template: string, replacements, relatedUser}} ]
counters: chat_messages, count_priority_chat, count_call_request_chat, unread_tips, messages, newTagsCount: int;
  hasSystemNotifications: bool
connected: bool, v: string
```

## 4. Open issues

- **`posts.expired`.** `post_expire` arrived about 480 times a day. Every id that could be traced to an owner (215 of
  1441, via `post_published`) was another creator's post in the feed; none was the account's. At that volume it looks like a feed cache-invalidation signal, not "a post
  expired", and it inflates the `posts.expired` count in `/v1/stats`. `contracts.ts` and `docs/webhooks.md` now say
  it fires for feed posts; filtering it (the frame is a bare id, so only a post lookup could) or dropping it is the
  owner's call.
- **Next captures.** A creator-side account's socket for a few days, with a tip (including a story tip), a new
  subscriber, a PPV unlock and a post like; outbound frames (typing); `online_status`. Then the 72 HTTP `?` rows, per
  the kit (a)/(b).
