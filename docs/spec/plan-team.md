# Plan team: members, invite links and per-member permissions

Build plan after plan-v6 (v2.1.0), for one implementer on **one wave** (branch `feat/team-members`). It lets a
workspace owner invite people (chatters) by link and limit each one to some creators and some features. It reverses
plan.md §11's "Team invitations, members page" cut, keeps every other §11 rule, and is additive: no plan-v5 §2 contract
changes, `/v1/whoami` gains fields, and the API-key surface is unchanged. Principles: **YAGNI** and **fail closed**
(anything a member's permissions do not name is refused).

**Model.** Infloww's (docs/spec/infloww-team-model.md §1–3) minus what we do not need: one login is one employee in one
agency, created by the agency, with creators assigned per employee. We drop its email activation, custom roles, groups,
data scopes and shifts. A member is **a person-bound API key**: the same account allowlist, plus a feature list.

**Known gaps after this plan:**
- There is no in-dashboard chat, vault or mass-message UI yet. A member uses the permissions through the API with the
  dashboard session: the Playground, and the Stats, Conversations and Revenue pages when they hold `stats`.
- A member cannot reset a forgotten password (no email). The owner removes them and sends a new invite; the operator
  can still run `auth:reset-link`.
- An invite link is shown once, at creation (only its hash is stored). A lost link is revoked and made again.

## 0. Baseline (2026-10-18, master a5c9057)

- **One workspace per user.** `ensureWorkspace` (`apps/api/src/auth.ts`) creates an `organization` and an `owner`
  `member` on sign-up; `member_userId_idx` (0004) is unique, so a user has one membership.
- **better-auth's organization plugin** is loaded, but `blockOrganizationWrites` refuses every `/organization/*` write
  except the workspace rename, so its `invitation` table and invite endpoints are unused.
- **Actors.** `/v1` resolves a key or the dashboard session to `Actor` (`plugins/actor.ts`). The session branch sets
  `accountIds: null` and `scope: 'write'`: every session is as strong as the owner.
- **Account guards** already keyed on `actor.accountIds`: `assertAccountAllowed` (proxy, stats, backfill, realtime),
  `connectedAccounts` (`GET /v1/accounts`), `scopedAccounts` (stats), the realtime hub, and the webhooks
  "keys limited to specific accounts" refusal.
- **`/api/*`** routes (keys, logs, usage and overview, account connect, edit, delete and browser login, proxies,
  webhook SSE stream) check `app.requireSession`: any signed-in user of the workspace.
- **Attribution.** `request_log.user_id` already records the session user of a proxied request.
- `pnpm -r typecheck` passes; api 402 tests and web 50 tests pass.

## 1. Decisions

1. **One login per person, one workspace per person.** `member_userId_idx` stays unique. No internal sub-accounts, no
   multi-agency, no workspace switcher (Infloww's is a client-side account list, §5).
2. **Members have no email.** They sign in with a username and password (better-auth `username` plugin). better-auth
   still needs a unique `user.email`: a member's is the synthetic `<user id>@members.invalid` (RFC 2606), never shown
   or mailed; derived from the id, it cannot go stale. Public sign-up refuses that domain and refuses `username` and
   `displayUsername` (403 `USERNAME_SET_BY_INVITE`), and `/update-user` refuses them too (a username is set once, by
   the invite). The login form takes a username or an
   email; the owner's email login is unchanged.
3. **Invite by link, no email.**
   - The owner creates an invite with permissions and gets `<APP_URL>/invite/<token>` once, to copy.
   - The token is 32 base62 characters; only its SHA-256 is stored. It is single-use, expires after 7 days, is
     revocable, and is tied to no identity. Log lines redact it (`/api/invites/<redacted>`, `/invite/<redacted>`).
   - The invitee opens the link and picks a username and password. The user, credential and `member` row are inserted
     in one transaction with the invite claim, so `ensureWorkspace` finds the membership and creates no workspace.
   - Valid invites bypass `REGISTRATION_OPEN` (the accept route inserts the user itself, not `/sign-up/email`).
   - `blockOrganizationWrites` stays. Our own routes do this; better-auth's invitation endpoints stay refused. It also
     keeps the organization reads and the rename for the owner: a member's `get-full-organization` or `list-members`
     would show every member's permissions and the owner's email.
4. **Permissions per member; no roles or presets.**
   - `member.allowed_account_ids int[] | null` (null = every creator the workspace owns, `{}` = none).
   - `member.features text[]` from `chats, mass_messages, vault, fans, stats, promo, settings`.
   - The owner's row ignores both: the owner can do everything.
   - The `_of/` raw passthrough is refused to members whatever their features.
5. **Enforcement: a member is a person-bound API key.** `Actor` gains `role: 'owner' | 'member' | null` (null = an
   API key) and `features` (every feature for API keys and the owner). The session branch of `authenticate` sets
   them and `accountIds` from the member row through one `effectivePermissions(row)` (team-contracts.ts), so the existing
   account guards apply unchanged. A session whose member row is gone is 401 (fail closed), not a new workspace.
   **One member check for all of `/v1`** (`gateMember`, an onRequest hook after `authenticate`): a member is refused
   (403 `owner_only`) every route that does not declare `config.member`, so a new route is owner-and-key-only by
   default. Declared:
   - `'allow'`: `GET /v1/whoami`, `GET /v1/accounts` (narrowed to the member's creators).
   - `'stats'`: `GET /v1/stats` and every `GET /v1/stats/*`, so `stats` also reads the stored message history
     (`/v1/stats/messages`, DM text and fan usernames) and the fan list with each fan's spend (`/v1/stats/fans`).
   - The proxy: a function of the decoded first path segment (§2.2, `modules/proxy/feature-gate.ts`); `_of` is 403
     `owner_only`, an unmapped segment 403 `feature_not_allowed`.
   - Undeclared, so refused: `/v1/webhooks*` (an endpoint receives every account's events), `PUT /v1/stats/config`
     (the workspace's stats windows for everyone), `POST /v1/stats/backfill` (spends the workspace's upstream quota)
     and `/v1/ws`.
6. **Owner-only `/api/*`.** `app.requireSession` becomes `app.requireOwner`: the same session and CSRF checks, then 403
   `owner_only` unless the member row's role is `owner`. Every existing `/api` route (keys, logs, usage, overview,
   account connect, edit, delete, browser login, proxies, webhook SSE stream) and the new team routes use it, so a
   member cannot mint an API key, connect an account or read the logs. There is no shared hook: each `/api` module adds
   `app.requireOwner` itself, and a new one must too.
   The exceptions: `GET /api/invites/:token` and `POST /api/invites/:token/accept` (no session) and `GET /api/me`
   (any signed-in user: role, permissions and workspace name, for the dashboard layout).
7. **Edit and remove.** The owner edits a member's creators and features (effective on the member's next request: the
   member row is read per request) and removes a member: delete the `user`, which cascades its `member`, `session`
   and `account` rows. The owner's own row cannot be edited or removed.
8. **Attribution.** Unchanged: `request_log.user_id`.

## 2. Contracts

### 2.1 Data (migration 0016)

- `user.username text unique`, `user.display_username text`: the username plugin's fields, from `auth:generate`.
- `member.allowed_account_ids integer[]`, `member.features text[] not null default '{}'`: declared as the organization
  plugin's `schema.member.additionalFields`, so `auth:generate` keeps them. `input: false`: the auth API never takes
  them.
- `team_invite` (ours, `schema.ts`): `id` (`inv_…`), `team_id` → organization (cascade), `token_hash` unique,
  `allowed_account_ids integer[]`, `features text[] not null`, `expires_at`, `used_at`, `revoked_at`, `created_by` →
  user (set null), `created_at`.
- Existing members get `features = '{}'`; only owners exist today, and owners ignore it.

### 2.2 Proxy feature map

The first segment of `/v1/{account}/<segment>/…`, decoded, mapped from the upstream route modules
(`services/upstream/routes/*.py`):

| Feature | Segments | Module |
|---|---|---|
| `chats` | `chats`, `giphy` | chats.py |
| `mass_messages` | `mass-messaging`, `queue` | chats.py (the scheduled-send routes) |
| `vault` | `media`, `posts`, `stories`, `saved-for-later` | content.py |
| `fans` | `fans`, `following`, `users`, `user-lists`, `me`, `subscribers` | fans.py |
| `stats` | `payouts`, `transactions`, `chargebacks`, `statistics`, `engagement` | money.py |
| `promo` | `tracking-links`, `trial-links`, `promotions`, `bundles` | promo.py |
| `settings` | `settings`, `notifications`, `release-forms` | settings.py |
| owner only | `_of` | passthrough.py |

Any other segment is 403 `feature_not_allowed` for a member. A test parses the upstream modules (`@router.<method>`
decorators and `router.add_api_route` loops) and fails when a new first segment has no row here.

### 2.3 Routes

| Route | Auth | Answer |
|---|---|---|
| `GET /api/team/members` | owner | `{items: Member[]}` |
| `PATCH /api/team/members/:id` | owner | `{member}`; body `{allowedAccountIds?, features?}`, at least one; 404 for the owner's row |
| `DELETE /api/team/members/:id` | owner | 204; 404 for the owner's row |
| `GET /api/invites` | owner | `{items: Invite[]}`: pending (unused, unrevoked, unexpired) only |
| `POST /api/invites` | owner | 201 `{invite, url}`; body `{allowedAccountIds, features}`, both required (`null` = all creators, `[]` = none) |
| `DELETE /api/invites/:id` | owner | 204; 404 when not pending |
| `GET /api/invites/:token` | none | `{workspace: {name}, expiresAt}`; 404 `invite_not_found`, 410 `invite_used` / `invite_revoked` / `invite_expired` |
| `POST /api/invites/:token/accept` | none (CSRF headers) | 201 `{username}`; body `{username, password}`; the 404/410s above; 409 `username_taken` |
| `GET /api/me` | any session | `{role, allowedAccountIds, features, workspace: {name}}` (every feature for the owner) |

- `Member`: `{id, userId, name, username, email, role, allowedAccountIds, features, createdAt}`. `email` is the
  owner's only (null for members); `username` is the display username.
- Usernames follow the plugin's defaults: 3–30 characters of `[a-zA-Z0-9_.]`, stored lowercased. Passwords 8–128.
- An allowlist naming an account the workspace does not own is 403 `account_not_allowed` (as for keys).
- **Accept is atomic:** `UPDATE team_invite SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND
  revoked_at IS NULL AND expires_at > now() RETURNING …`, then the user, account and member inserts, in one
  transaction. A duplicate username rolls it back, so the invite stays usable. The page then signs in with
  `/api/auth/sign-in/username`.
- `/v1/whoami` `user` gains `role` (`owner` | `member`), `allowedAccountIds` and `features` (the full list for the owner).
- Errors: 403 `owner_only` (an `/api` route or `_of/` for a member), 403 `feature_not_allowed`.

### 2.4 Web

- `/team` (owner): members table (creators, features, edit, remove) and pending invites (created, expires, revoke);
  "Create invite" opens the permissions dialog and then shows the link with Copy. The creator field is the API-key
  dialog's, moved to `components/account-ids-field.tsx` and used by both.
- `/invite/$token`: shows the workspace name or why the link is dead; username and password form; signs in and opens
  the dashboard.
- Login: one "Email or username" field; an `@` selects email sign-in.
- Layout: members see Home, Playground, and Stats, Conversations and Revenue with `stats`. Home shows a member their
  workspace, creators and features instead of the owner KPIs. The webhook SSE stream opens for owners only. The
  layout and Home read `GET /api/me` (not `/v1/whoami`, which is rate-limited) and show the owner's view unless it
  confirms a member.
- The permissions dialog makes "All creators" its own checkbox; unchecked, an empty list means none.

## 3. Slices

1. **Migration.** `auth.ts` loads `username()` and the member `additionalFields`; `pnpm --filter @gateway/api
   auth:generate` (keep the hand-edited unique `member_userId_idx`); `team_invite` in `schema.ts`; `db:generate`.
2. **API.** `Actor.features`, the session branch, `requireOwner`, the proxy gate, the stats, webhooks and stats-config
   checks, `modules/team/{routes,service}.ts`, whoami fields.
3. **Web.** As §2.4.
4. **Tests** (`test/team.test.ts`):
   - a member is refused outside their creators and features, on `_of/`, on unmapped segments, on every undeclared
     `/v1` route (webhooks, `/v1/ws`, `PUT /v1/stats/config`, `POST /v1/stats/backfill`) and on every owner `/api`
     route, and allowed inside them; `[]` creators reach none; a member whose row is gone is 401 with no new workspace;
   - an edit takes effect on the next request; remove ends the member's session;
   - invites: accept joins the owner's workspace with no new workspace and under `REGISTRATION_OPEN=false`; expired,
     reused, revoked, unknown, duplicate username (invite stays usable); concurrent accepts of one token give one user;
   - username sign-in works; a member cannot rename the workspace (name unchanged), use better-auth's organization
     writes or reads, or change their username; public sign-up cannot take a `members.invalid` email or set a
     username;
   - an invite token never reaches the log;
   - the feature map covers every upstream first segment.

## 4. Env additions

None.

## 5. Not in this plan

Custom roles and presets, shifts, groups, "own data only" scope, multi-agency, email sending, member API keys, member
password reset, re-showing an invite link, disabling (rather than removing) a member.
