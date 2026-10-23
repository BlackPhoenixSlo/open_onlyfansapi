# Authentication

The gateway has two ways in: API keys for programs, and the dashboard session for people signed in to the
dashboard. This page covers both, plus scopes, account limits, rate limits and errors.

## Which surface accepts what

| Path | Accepts |
|---|---|
| `/v1/*` | An API key (`Authorization: Bearer ...`), or the dashboard session with `x-dashboard: 1` |
| `/api/*` | The workspace owner's dashboard session only. API keys and team members are not accepted. Exceptions: `GET /api/me`, `GET /api/help` and `POST /api/help/ask` take any signed-in user (owner or member); `GET /api/invites/<token>` and `POST /api/invites/<token>/accept` take no session (the invite token is the credential). |
| `/openapi.json`, `/docs`, `/healthz` | Anyone. No credentials needed. |

`/api/auth/*` handles sign-up, sign-in and the session itself. It checks the request origin against
`APP_URL` on its own.

## API keys

### Format and storage

A key looks like `gk_` followed by 32 letters and digits, for example `gk_4fT9...`. It belongs to one
workspace.

The full secret is shown once, right after you create the key. The gateway stores only its SHA-256 hash, so
it cannot show the key again. If you lose a key, create a new one and revoke the old one. The key list shows
the first 12 characters of each key so you can tell them apart.

### Managing keys

Keys are managed on the **API keys** page of the dashboard. A key cannot create or change other keys.

- **Create:** give it a name (1 to 100 characters), a scope (default `read`) and, optionally, a list of
  allowed accounts (default: all).
- **Edit:** the name, scope and allowed accounts can be changed later. Changes apply to the next request.
- **Revoke:** takes effect at once and cannot be undone. A revoked key gets `401 invalid_api_key`. It stays
  in the list, marked as revoked.
- **Last used:** updated when the key is used, at most once a minute.

### Sending a key

Put the key in the `Authorization` header:

```sh
curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/v1/whoami
```

Any `Authorization` header counts as a key attempt. A missing, malformed, unknown or revoked key in that
header gets `401 invalid_api_key`.

## Scopes

| Scope | Allows |
|---|---|
| `read` | `GET` and `HEAD` only. Any other method gets `403 insufficient_scope`. |
| `write` | All methods. |

## Account allowlist

Each key has an optional list of account ids.

- **Empty (`null`):** the key can use every account the workspace owns (the accounts connected from its dashboard).
  Another workspace's accounts are never reachable: a call for one gets `403 account_not_allowed`.
- **A list:** the key can use only those accounts. A call to `/v1/{account}/...` for any other account gets
  `403 account_not_allowed`. `/v1/accounts` shows only the allowed accounts. The list may name only accounts the
  workspace owns; any other id gets `403 account_not_allowed` when the key is created or edited.

`/v1/whoami` returns the key's scope and allowlist, so a program can check what it may do.

## Dashboard session

The dashboard calls the API with its session cookie. The owner's session has `write` access to every account in
the workspace; a team member's is limited (see [Team members](#team-members)).

- On `/v1/*`, the cookie is used only when the request also sends `x-dashboard: 1`. Without that header the
  cookie is ignored and the request gets `401 unauthorized`.
- Every cookie-authenticated write (any method except `GET`, `HEAD` and `OPTIONS`) on `/api/*` or `/v1/*`
  must send `x-dashboard: 1` and an `Origin` header equal to the origin of `APP_URL`. Otherwise it gets
  `403 csrf_failed`. This blocks other sites from using a signed-in browser.

The playground uses the session, so no API key is needed in the browser. Its requests show up in the logs
with the key "Dashboard".

### Key and cookie together

If a request carries both an `Authorization` header and a session cookie, the key wins. If the key is
invalid, the request gets `401 invalid_api_key`. The gateway does not fall back to the cookie.

## Team members

The owner invites people from the dashboard's Team page. "Create invite" takes the member's creators (all, or a
list of account ids, which may be empty) and features, and shows a link `<APP_URL>/invite/<token>` once. The link
works once, for 7 days, and can be revoked; it is not tied to an email, and log lines show it as `<redacted>`. The invitee picks a username and password on that page and joins the
owner's workspace (also when `REGISTRATION_OPEN=false`). Members have no email: they sign in with their username,
which cannot be changed afterwards. A forgotten password means the owner removes the member first (the username
stays taken while they exist), then sends a new invite. Usernames come only from invites:
public sign-up (`/api/auth/sign-up/email`) with a `username` or `displayUsername` answers 403
`USERNAME_SET_BY_INVITE`.

A member's session works like an API key bound to that person:

- `/v1/{account}/*` reaches only the member's creators (`403 account_not_allowed`) and only routes whose first
  path segment belongs to one of their features (`403 feature_not_allowed`):

  | Feature | Routes |
  |---|---|
  | `chats` | `chats`, `giphy` |
  | `mass_messages` | `mass-messaging`, `queue` |
  | `vault` | `media`, `posts`, `stories`, `saved-for-later` |
  | `fans` | `fans`, `following`, `users`, `user-lists`, `me`, `subscribers` |
  | `stats` | `payouts`, `transactions`, `chargebacks`, `statistics`, `engagement`, and the `GET /v1/stats*` reads, which include the stored message history (`/v1/stats/messages`) and the fan list with each fan's spend (`/v1/stats/fans`) |
  | `promo` | `tracking-links`, `trial-links`, `promotions`, `bundles` |
  | `settings` | `settings`, `notifications`, `release-forms` |

- Every other `/v1` route answers `403 owner_only`: the raw passthrough `_of/`, `/v1/webhooks*`, `/v1/ws`,
  `PUT /v1/stats/config` and `POST /v1/stats/backfill`. New `/v1` routes are refused to members unless they say
  otherwise. So does every `/api/*` route (keys, logs, usage, accounts, proxies, the event stream, the team itself)
  except `GET /api/me` and the help assistant (`/api/help`).
- `GET /v1/accounts` lists only the member's creators, and `GET /v1/whoami` and `GET /api/me` return the role,
  `allowedAccountIds` and `features`.
- better-auth's organization endpoints (`/api/auth/organization/*`), reads included, are the owner's.

The owner can change a member's creators and features (applied on the member's next request) or remove the member
(their login and sessions are deleted). Logged requests keep the member's user id.

## Rate limits

Each API key may make `KEY_RATE_LIMIT_PER_MIN` requests per minute to `/v1` (120 by default). Dashboard
sessions are counted per user. Over the limit, the gateway answers `429 rate_limited` with a `retry-after`
header. The count is kept in memory by each API process.

The upstream has its own limits. Its `429` responses pass through unchanged, with their `Retry-After` and
`x-ratelimit-*` headers.

## Errors

Errors produced by the gateway have this shape:

```json
{ "error": { "code": "insufficient_scope", "message": "This API key is read-only", "requestId": "req_..." } }
```

Every response, success or error, carries an `x-request-id` header with the same id. The gateway also sends
it to the upstream. Include it when you report a problem.

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` | The request failed validation on a gateway route. |
| 400 | `invalid_path` | The path after `/v1/{account}` has a `.` or `..` segment, or an encoded `/` or `\`. |
| 401 | `unauthorized` | No API key and no usable dashboard session. |
| 401 | `invalid_api_key` | The `Authorization` header is malformed, or the key is unknown or revoked. |
| 403 | `insufficient_scope` | A `read` key used a method other than `GET` or `HEAD`. |
| 403 | `account_not_allowed` | The account is not in the key's (or team member's) allowlist, or the workspace does not own it. |
| 403 | `csrf_failed` | A cookie-authenticated write lacked `x-dashboard: 1` or the right `Origin`. |
| 403 | `owner_only` | A team member used a route for the workspace owner. See [Team members](#team-members). |
| 403 | `feature_not_allowed` | A team member used a route outside their features. |
| 404 | `not_found` | Unknown route, a non-numeric account id, or a key or log entry that does not exist. |
| 409 | `team_not_linked` | The workspace is not linked to the upstream (sign-up links it; `link-team` repairs it). See [getting-started.md](getting-started.md). |
| 429 | `rate_limited` | The key or user went over the per-minute limit. |
| 500 | `internal_error` | Something failed inside the gateway. |
| 502 | `upstream_unavailable` | The gateway could not reach the upstream. |
| 502 | `upstream_error` | The upstream returned an error for the account list (`/v1/accounts`). |
| 504 | `upstream_timeout` | The upstream did not answer within `UPSTREAM_TIMEOUT_MS` (30 seconds by default). |

Other HTTP-level failures use a code based on the status: `bad_request` (400), `payload_too_large` (413) and
`unsupported_media_type` (415, for a body type the gateway does not read; send JSON). The dashboard's own
`/api` routes also use `invalid_range`, `range_too_large` and `invalid_cursor`; `/v1/stats` uses `invalid_range` and
`range_too_large`.

### Upstream errors

Calls under `/v1/{account}/` are forwarded to the upstream. When the upstream answers with an error, the
gateway passes the status and body through unchanged. Those errors do not use the shape above. Only the
gateway's own errors do.
