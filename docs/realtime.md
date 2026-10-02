# Realtime events (WebSocket)

`GET /v1/ws` is a WebSocket that streams the same events webhooks carry, as they happen. It uses the same `gk_`
API key as the REST API. Each frame body has the same shape as a webhook body. Frames are not signed, because the
socket itself is authenticated.

## Connecting

The key goes in the handshake. Browsers cannot set headers on a WebSocket, so the key travels as a subprotocol.
Offer **both** `bearer` and `bearer.<key>`. The gateway selects `bearer`, so the response header
`Sec-WebSocket-Protocol: bearer` never contains the key.

Browser:

```js
const ws = new WebSocket('wss://gateway.example.com/v1/ws', ['bearer', 'bearer.' + apiKey]);
ws.onmessage = (m) => {
  const frame = JSON.parse(m.data);
  if (frame.type === 'ready') return console.log('streaming accounts', frame.accountIds ?? 'all');
  console.log(frame.type, frame.accountId, frame.data);
};
ws.onclose = (e) => console.log('closed', e.code, e.reason);
```

Node 22 or later (the global `WebSocket`) works the same way:

```js
const ws = new WebSocket(`wss://gateway.example.com/v1/ws?accountId=117183`, ['bearer', `bearer.${process.env.API_KEY}`]);
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

- First, once: `{"type":"ready","accountIds":[117183]}`. `accountIds` lists the accounts this socket receives: the
  `accountId` filter, otherwise the key's allowed accounts, or `null` for every account.
- Then one frame per event, the same body as a webhook delivery:

```json
{"id":"evt_...","type":"message.received","createdAt":"2026-10-02T12:00:00.000Z","accountId":117183,
 "data":{"messageId":5551234,"fanId":42,"text":"hi","price":0,"mediaCount":0}}
```

See [webhooks.md](webhooks.md#event-types) for the event types. An event with no account (`accountId: null`) goes
only to sockets that see every account. Messages the client sends are ignored. A client message larger than 4 KiB
closes the socket (1009).

## Refusals

Every refusal happens before the upgrade, as a normal HTTP error with the usual
`{"error":{"code","message","requestId"}}` body. Each refusal is also written to the request log.

| Status | Code | Why |
|---|---|---|
| 401 | `invalid_api_key` | Missing, malformed, unknown or revoked key |
| 401 | `unauthorized` | No key at all, or the dashboard session (sockets take API keys only) |
| 400 | `invalid_subprotocol` | `bearer.<key>` was offered without `bearer` |
| 400 | `validation_error` | `accountId` is not a positive integer |
| 403 | `account_not_allowed` | `accountId` is outside the key's allowed accounts |
| 409 | `team_not_linked` | The workspace is not linked to the upstream yet |
| 429 | `rate_limited` | The key's per-minute request limit (the handshake counts as one request) |
| 429 | `too_many_sockets` | The key already holds 5 open sockets |
| 503 | `realtime_unavailable` | This gateway has no event source (`UPSTREAM_WS_URL` unset, or `RUN_JOBS=false`) |

A browser does not expose the HTTP status of a refused handshake. It only reports an `error` and a close with code
1006. To see why a handshake was refused, check the request log or try the same request with curl.

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
resync what you need from the REST API, for example `GET /v1/{account}/chats/{chatId}/messages`. If you need
retries, use [webhooks](webhooks.md). They are retried with backoff.

## Request log

Each socket session is one request log row: `GET /v1/ws` with status `101`, the handshake time as its duration,
the redacted request headers and query, and the `accountId` filter. When the socket closes, the row gets the bytes
sent (`resp_bytes`) and the close reason as `error_code`. A normal close or a shutdown leaves `error_code` empty.
Otherwise it holds one of the reasons in the table above, or `pong_timeout` or `connection_lost`. Session length is not stored.
Neither the `Authorization` header nor `Sec-WebSocket-Protocol` is ever stored.

## Tenancy

The gateway runs for a single operator. Under one upstream, **every linked workspace sees every account's events**,
like it sees every account's REST data and webhooks. Event frames include fan message text. A key's allowed accounts
(and the `accountId` filter) narrow what one socket receives, but they are not a tenancy boundary between workspaces.
Separate workspaces would need an account-to-workspace mapping, which does not exist yet.
