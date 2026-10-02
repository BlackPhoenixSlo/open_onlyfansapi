# Realtime events (WebSocket)

`GET /v1/ws` is a WebSocket that streams the same events webhooks carry, as they happen. It uses the same `gk_`
API key as the REST API. Each frame body has the same shape as a webhook body. Frames are not signed, because the
socket itself is authenticated.

## Connecting

The key goes in the handshake. Browsers cannot set headers on a WebSocket, so the key travels as a subprotocol.
Offer **both** `bearer` and `bearer.<key>`. The gateway selects `bearer`, so the response header
`Sec-WebSocket-Protocol: bearer` never contains the key.

A key in a browser can be read by whoever uses that browser. For browser clients, use a `read` key limited to the
accounts the page needs, and never put a key in a public page. Server-side clients should send the key in the
`Authorization` header (below) instead of the subprotocol.

If a reverse proxy sits in front of the gateway, check its access logs. Some proxies record request headers, and
the `Sec-WebSocket-Protocol` header carries the key (Caddy's default log redaction does not cover it).

Browser:

```js
const ws = new WebSocket('wss://gateway.example.com/v1/ws', ['bearer', 'bearer.' + apiKey]);
ws.onmessage = (m) => {
  const frame = JSON.parse(m.data);
  if (frame.type === 'ready') return console.log('streaming accounts', frame.accountIds ?? 'all');
  console.log(frame.event, frame.account_id, frame.payload);
};
ws.onclose = (e) => console.log('closed', e.code, e.reason);
```

Node 22 or later (the global `WebSocket`) works the same way:

```js
const ws = new WebSocket(`wss://gateway.example.com/v1/ws?accountId=1001`, ['bearer', `bearer.${process.env.API_KEY}`]);
ws.addEventListener('message', (m) => console.log(JSON.parse(m.data)));
```

A client that can set headers, such as the `ws` package, may send `Authorization: Bearer <key>` instead and offer
no subprotocol:

```js
import WebSocket from 'ws';
const ws = new WebSocket('wss://gateway.example.com/v1/ws', { headers: { Authorization: `Bearer ${process.env.API_KEY}` } });
```

The gateway reads the subprotocol key only on a WebSocket upgrade. On any other request, an `Authorization`
header is the only way to send a key.

`?accountId=<id>` limits the socket to one account. Without it, the socket receives every account the key allows.

## Frames

Every frame is one JSON object in a text frame.

- First, once: `{"type":"ready","accountIds":[1001]}`. `accountIds` lists the accounts this socket receives: the
  `accountId` filter, otherwise the key's allowed accounts, or `null` for every account.
- Then one frame per event, byte for byte the same JSON as a webhook delivery body (`event`, `account_id` as a
  string, `payload`; see [webhooks.md](webhooks.md#the-request)):

```json
{"event":"messages.received","account_id":"1001","payload":{"id":1002,"text":"hi","fromUser":{"id":1003}}}
```

Only `ready` has a `type` key; an event frame has `event` instead. See [webhooks.md](webhooks.md#event-types) for
the event types. An event with no account has no `account_id` key and goes only to sockets that see every account.
Frames carry no event id and no `X-OFAPI-Idempotency-Key`: the socket has no retries to de-duplicate. Messages the
client sends are ignored. A client message larger than 4 KiB closes the socket (1009).

## Refusals

Every refusal happens before the upgrade, as a normal HTTP error with the usual
`{"error":{"code","message","requestId"}}` body. Refusals after the key was accepted (every row below except the
401s) are also written to the request log; a 401 has no key, so it has no workspace to log under.

| Status | Code | Why |
|---|---|---|
| 401 | `invalid_api_key` | Malformed, unknown or revoked key |
| 401 | `unauthorized` | No key at all, or the dashboard session (sockets take API keys only) |
| 400 | `invalid_subprotocol` | `bearer.<key>` was offered without `bearer` |
| 400 | `validation_error` | `accountId` is not a positive integer |
| 403 | `account_not_allowed` | `accountId` is outside the key's allowed accounts |
| 409 | `team_not_linked` | The workspace is not linked to the upstream yet |
| 429 | `rate_limited` | The key's per-minute request limit (the handshake counts as one request) |
| 429 | `too_many_sockets` | The key already holds 5 open sockets |
| 503 | `realtime_unavailable` | This gateway has no event source (`UPSTREAM_WS_URL` unset, or `RUN_JOBS=false`) |

A browser does not expose the HTTP status of a refused handshake. It only reports an `error` and a close with code
1006. To see why a handshake was refused, repeat it with curl, which prints the status and the error body:

```sh
curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Authorization: Bearer $API_KEY" \
  "https://gateway.example.com/v1/ws?accountId=1001"
```

Refusals after the key was accepted also appear in the request log.

## Close codes

| Code | Reason | Meaning | What to do |
|---|---|---|---|
| 1001 | `shutdown` | The gateway is restarting | Reconnect with backoff |
| 1013 | `slow_consumer` | More than 1 MiB of frames were waiting for the client to read them | Read faster, then reconnect |
| 4401 | `invalid_api_key` | The key was revoked or deleted | Do not reconnect with this key |
| 4401 | `team_not_linked` | The workspace was unlinked | Do not reconnect until it is linked again |
| 4403 | `account_not_allowed` | The `accountId` filter is no longer in the key's allowed accounts | Reconnect without it, or with an allowed account |

The gateway checks every open socket's key every 15 seconds, so revoking a key, editing its allowed accounts or
unlinking the workspace takes effect within 15 seconds, even on an idle socket. On a socket without an `accountId`
filter, an allowed-accounts edit is applied in place. The socket stays open, delivers only the new set, and its
`ready.accountIds` value is not re-sent. The gateway pings each socket every 15 seconds and drops one that did not
answer the previous ping. Browsers and Node answer pings on their own.

## Delivery: at most once

The socket delivers each event at most once. There is no replay, no resume cursor and no gap marker. Events that
happen while a client is disconnected, or that are dropped for a slow client, are not sent later. After a reconnect,
resync what you need from the REST API, for example `GET /v1/{account}/chats/{chat_id}/messages`. If you need
retries, use [webhooks](webhooks.md). They are retried with backoff.

## Request log

Each socket session is one request log row: `GET /v1/ws` with status `101`, the handshake time as its duration,
the redacted request headers and query, and the `accountId` filter. When the socket closes, the row gets the bytes
sent (`resp_bytes`) and the close reason as `error_code`. Session length is not stored. Neither the `Authorization`
header nor `Sec-WebSocket-Protocol` is ever stored.

- `error_code` holds the gateway's close reason from the table above, or `pong_timeout`.
- A shutdown, and any close the client starts, leave it empty, whatever close code the client sent. The exception is
  a connection that drops without a close (1006), which is `connection_lost`.
- A client message over 4 KiB also shows up as `connection_lost`.
- If the gateway crashes, open sessions keep `resp_bytes` 0 and an empty `error_code`.

## Limits

- The 15-second check needs the database. While the database is unreachable, the check does nothing: revocations,
  allowed-account edits and unlinks wait until it is back. Pings stop with it.
- A socket stops counting toward the key's 5-socket limit as soon as the gateway closes it, even if a slow consumer
  (1013) is still draining its last frames.

## Tenancy

The gateway runs for a single operator. Under one upstream, **every linked workspace sees every account's events**,
like it sees every account's REST data and webhooks. Event frames include fan message text. A key's allowed accounts
(and the `accountId` filter) narrow what one socket receives, but they are not a tenancy boundary between workspaces.
Separate workspaces would need an account-to-workspace mapping, which does not exist yet.
