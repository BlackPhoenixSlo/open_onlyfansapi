// The help assistant's manual: the only thing it may answer from (prompt.ts). A TS module, not a .md file: the
// Docker image ships apps/api/dist only. Pages are linked as markdown links the web turns into clickable links only
// when they pass its allowlist (apps/web/src/features/help/links.ts); apps/web/src/features/help/manual.test.ts checks
// every sidebar route has a '## [Label](/route)' section here and every link passes that allowlist. Write it from the
// code, not from plans.

/** The public mirror's files on GitHub: the only external links the web allows (links.ts). */
export const DOCS = 'https://github.com/BlackPhoenixSlo/open_onlyfansapi/blob/master';

export const MANUAL = `# OpenOnlyfansAPI manual

OpenOnlyfansAPI is a self-hosted API gateway and dashboard in front of an upstream service that holds OnlyFans (OF)
account sessions. A workspace connects its OF accounts, creates scoped API keys, and calls \`/v1/{account}/...\`; the
gateway checks the key, forwards the call to the upstream, and records it. Each server is run by its own operator
(the person who deployed it), on its own domain. Nothing here is a hosted service: there are no plans, billing or
support desk.

## Roles

Every signed-in user is either the workspace **owner** or a team **member**.

- The **owner** created the workspace by registering. The owner sees every page and can do everything below.
- A **member** joined through an invite link from the owner (see [Team](/team)). A member signs in with a username,
  not an email, and sees only: [Home](/dashboard), [Playground](/playground), and, with the \`stats\` feature,
  [Stats](/stats), [Conversations](/conversations) and [Revenue](/revenue).
- A member never sees [Accounts](/accounts), [API keys](/keys), [Team](/team), [Logs](/logs), [Usage](/usage),
  [Webhooks](/webhooks) or [Settings](/settings). Typing one of those addresses sends them back to Home. Only the
  owner can change a member's creators or features.
- A member's calls reach only their creators (accounts) and the routes of their features; anything else answers
  \`403 account_not_allowed\`, \`403 feature_not_allowed\` or \`403 owner_only\`.
  Details: [Team members](${DOCS}/docs/authentication.md#team-members).

## Pages

The sidebar on the left lists the pages the signed-in user may open.

## [Home](/dashboard)

Who: everyone.
- Owner: KPI cards **Requests (24h)**, **Error rate (24h)** and **Active keys**; a **Needs attention** card that lists
  webhook endpoints that are paused or failing, each linking to its deliveries; and a **View usage** link.
- Member: a "Team member of <workspace>" card listing their **Creators** and **Features**, and an
  **Open the Playground** link. "None yet. Ask the owner." means the owner gave them no features.

## [Accounts](/accounts)

Who: owner only. Connect OF accounts, set their proxies, and start analytics.
- **Connect account**: paste a cURL of a signed-in OF request. Get it with the Fastt extension (open it, press
  **Copy curl**), or from Chrome: sign in to onlyfans.com as the account (an incognito window keeps your own login),
  DevTools → Network → any \`api2/v2\` request → Copy as cURL (bash). Optional **Nickname** and **Proxy**
  (\`http://user:pass@host:port\` or \`socks5h://...\`; empty = the server's own IP, or keep the proxy the account has).
  Press **Connect**. The account then belongs to this workspace only.
- **Browser login**: a real browser signs the account in through its proxy with the OF email and
  password; you solve any captcha or 2FA prompt yourself in the dialog. The password is sent once and never stored.
- **Try Browserbase login**: the same in a remote Browserbase browser, so it works on a phone and needs no extension.
  It works only if the operator set \`BROWSERBASE_API_KEY\` and \`BROWSERBASE_PROJECT_ID\` on the server.
- The table shows Display name, Username, Label, ID and Status. Status \`session_expired\` means OF refused the
  session: use **Connect account** again with a fresh cURL for the same account.
- **Run analytics (N days)** (30, 90 or 180 days; active accounts only) backfills the account's history for
  [Stats](/stats), [Conversations](/conversations) and [Revenue](/revenue). It runs in the background, shows
  \`Running…\`, then \`Done · view Stats\`. Long ranges take hours. See
  [Analytics backfill](${DOCS}/docs/analytics-backfill.md#from-the-dashboard).
- The **…** menu on a row: **Edit** (label and proxy) and **Disconnect** (deletes the account's session here; its
  analytics history is kept and it can be connected again later).
- **Proxies** card: **Add proxy** (a label and a proxy URL), **Paste proxies** (one per line: \`host:port:user:pass\`,
  \`user:pass@host:port\` or \`scheme://user:pass@host:port\`, optional label after a space), and **Test** per proxy
  (shows its egress IP). OK / Blocked / Failed count responses through each proxy.
- "Workspace not linked": the operator must link the workspace (Settings shows the slug and the command).

## [API keys](/keys)

Who: owner only.
- **Create key**: **Name** (1 to 100 characters), **Scope** \`read\` (GET and HEAD only, the default) or \`write\` (every
  method), and **Allowed account IDs** (empty = every account the workspace owns). The secret (\`gk_...\`) is shown
  once in "Your new API key" with **Copy**; it cannot be shown again.
- The table shows Name, Key (the first characters), Scope, Accounts, Created, Last used and Status. Clicking a key's
  name opens [Usage by key](/usage?groupBy=key).
- The **…** menu on a key: **Edit** (rename, change the scope, change the allowed accounts; applies to the next
  request) and **Revoke** (immediate, cannot be undone; the key then gets \`401 invalid_api_key\`).
- Lost a key? Create a new one and revoke the old one.
  Details: [Authentication](${DOCS}/docs/authentication.md).

## [Team](/team)

Who: owner only. Invite people to the workspace and set what they may use.
- **Create invite**: choose **Creators** ("All creators, including ones connected later", or "Only these account IDs";
  an empty list means none) and **Features**, then **Create invite**. The **Invite link** (\`/invite/<token>\`) is shown
  once; it works once, for 7 days, and is not tied to an email. Send it to the person yourself.
- Features: Chats (\`chats\`), Mass messages and queue (\`mass_messages\`), Vault, posts and stories (\`vault\`), Fans and
  lists (\`fans\`), Stats, earnings, stored messages and fan spend (\`stats\`), Promotions (\`promo\`), Creator settings
  (\`settings\`). None selected = the member can sign in but use nothing. API keys, logs, webhooks, accounts and the
  raw passthrough stay owner-only.
- The invitee opens the link, picks a username (3 to 30 letters, digits, \`_\` or \`.\`) and a password (8 or more
  characters), and signs in with that username.
- **Pending invites** lists unused links with **Revoke**.
- The members table shows Member, Role, Creators, Features and Joined. The **…** menu on a member: **Edit permissions**
  (applies on their next request) and **Remove** (deletes their login at once; their past requests stay in the logs).
- A member forgot their password: remove them, then send a new invite.

## [Logs](/logs)

Who: owner only. Every authenticated \`/v1\` request of the workspace, newest first.
- Filters: status (2xx, 4xx, 5xx, Any error), method, key, account, "Endpoint contains…" and "Request ID or path…",
  then **Search**; **Clear** resets them; **Load more** at the bottom.
- Click a row for the request detail (\`/logs/<id>\`): summary, request and response, **Copy as cURL** and
  **Open in playground**.
- Credential headers are never stored. Bodies are kept for failed requests by default (\`LOG_BODIES\`), and logs for
  14 days (\`LOG_RETENTION_DAYS\`). Playground calls show the key "Dashboard".

## [Usage](/usage)

Who: owner only.
- Range **24h**, **7d** or **30d**; a **Requests per day (UTC)** chart.
- Group the table by **day**, **key**, **account** or **endpoint**, e.g. [Usage by key](/usage?groupBy=key): Requests,
  Errors, Error %, Avg ms, Bytes and Share. **Export CSV** downloads the table.

## [Stats](/stats)

Who: the owner, and members with the \`stats\` feature. Chat performance from what the analytics backfill stored.
- Needs data first: on [Accounts](/accounts), press **Run analytics** for the account. While a backfill runs, a line
  under the range says so, and the cards fill in when it ends.
- Pick an account (or All accounts) and a range: **7d**, **30d** or **custom** (from and to days).
- Cards: Median reply time, Reply SLA, Openers, Scripts and Fan turns; charts by day and by hour of day; a
  **Scripts** card; a **Fans** card with **Download fan replies (CSV)** and **Download all messages (CSV)**.
- **Raw data** shows a metric by day with CSV export and the metric catalogue. Every metric is marked unverified.
- A daily refresh and an hourly sales poll run only if the operator set \`STATS_REFRESH_HOUR_UTC\`; otherwise run
  analytics again for newer data.
  Details: [Analytics](${DOCS}/docs/analytics.md).

## [Conversations](/conversations)

Who: the owner, and members with the \`stats\` feature.
- The same account and range picker as Stats. The left list holds every fan with a stored message in the range
  (search by username, name or chat id); pick one to read the thread on the right.
- In a thread: **Hide mass not bought** (on by default) and **Download CSV**.
- Only stored messages show: backfilled ranges plus live events received while the gateway was connected.

## [Revenue](/revenue)

Who: the owner, and members with the \`stats\` feature.
- The same account and range picker as Stats. Cards: Gross, Net, Transactions, Payers, Fan CVR, Golden ratio and
  PPV unlock (DM); **Gross by day**, **By kind**, and **Top payers** (the 50 fans who paid the most in the range).
- Sales come from the analytics backfill (and the hourly poll when \`STATS_REFRESH_HOUR_UTC\` is set).

## [Webhooks](/webhooks)

Who: owner only. Push events to your own HTTPS endpoints.
- **Add endpoint**: **URL** (\`https://\`; \`http://\` only if the operator allows it), **Description**, and **Events** (none selected = every event). After
  saving, the dialog shows the **Signing secret** (\`whsec_...\`) with **Reveal** and **Copy**; **Edit** shows it again.
  Verify the \`Signature\` header: hex HMAC-SHA256 of the raw body, keyed with the secret.
- The table shows URL, Events, Health, **Enabled** (untick to pause, tick to resume) and Created. The **…** menu:
  **Edit**, **Send test event**, **Deliveries** and **Delete**.
- Deliveries (\`/webhooks/<id>\`, open it from the URL or the menu): filter by status and event, **Payload**, and
  **Redeliver**.
- Failed deliveries retry after 30 s, 2 m, 10 m, 1 h and 6 h; after 20 failed deliveries in a row the endpoint is
  paused, and ticking **Enabled** resumes it.
- **Enable browser notifications** and the **Live events** card show events as they arrive.
  Details: [Webhooks](${DOCS}/docs/webhooks.md).

## [Playground](/playground)

Who: everyone (a member is limited to their creators and features).
- **Search operations…**, pick one, choose the account, fill in the parameters, query and JSON body, then **Send**.
- The response shows as JSON or a table, with **Copy**; the **curl** section has **Copy** for the same call.
- It uses your dashboard session: no API key is pasted into the browser. Its requests show in [Logs](/logs) with
  the key "Dashboard". A logged request can be reopened here with **Open in playground**.

## [Settings](/settings)

Who: owner only.
- Workspace **Name** with **Save**. The **Slug** is shown read-only.
- **Upstream link**: "Linked to the upstream", or "Not linked" with the command the operator runs to link it.

## [API reference](/docs)

Who: anyone, no sign-in. The interactive reference of every \`/v1\` route, including the upstream's operations. The
raw OpenAPI document is [openapi.json](/openapi.json).

## Using the API

- Call \`/v1/{account}/<path>\` with \`Authorization: Bearer gk_...\`; the gateway forwards it to the upstream and passes
  the status and body back unchanged. \`GET /v1/accounts\` lists the accounts a key may use, and \`GET /v1/whoami\`
  shows its scope and allowlist.
- Scopes: a \`read\` key may only use GET and HEAD (\`403 insufficient_scope\` otherwise); a \`write\` key may use any
  method. [Scopes](${DOCS}/docs/authentication.md#scopes).
- Account allowlist: a key limited to some accounts gets \`403 account_not_allowed\` for any other.
  [Account allowlist](${DOCS}/docs/authentication.md#account-allowlist).
- Rate limit: 120 requests a minute per key by default (\`KEY_RATE_LIMIT_PER_MIN\`, set by the operator for the
  whole server); over it the answer is \`429 rate_limited\` with \`retry-after\`. The upstream's own 429s pass through.
  [Rate limits](${DOCS}/docs/authentication.md#rate-limits).
- Realtime: \`GET /v1/ws\` is a WebSocket with the same events as webhooks, authenticated with a key.
  [Realtime events](${DOCS}/docs/realtime.md).
- Webhooks can also be managed by API under \`/v1/webhooks\` with a \`write\` key.

## Common errors

Full list: [Errors](${DOCS}/docs/authentication.md#errors).
- \`401 unauthorized\`: no key and no usable session. \`401 invalid_api_key\`: the key is malformed, unknown or revoked.
- \`403 insufficient_scope\`: a \`read\` key used a method other than GET or HEAD. Edit the key's scope on [API keys](/keys).
- \`403 account_not_allowed\`: the account is not in the key's (or member's) allowlist, or the workspace does not own it.
- \`403 owner_only\`: a team member used something only the owner may use (on \`/v1\` and \`/api\` alike). Ask the owner.
- \`403 feature_not_allowed\`: a member used a route outside their features. Ask the owner to add the feature.
- \`403 csrf_failed\`: a cookie-authenticated write without \`x-dashboard: 1\` and the dashboard's Origin. Scripts should
  use an API key instead of the session.
- \`409 team_not_linked\`: the workspace is not linked to the upstream. Sign-up links it; the operator repairs it with
  \`link-team\` (see [Settings](/settings) for the slug).
- \`429 rate_limited\`: over the per-minute limit; wait for \`retry-after\`.
- \`502 upstream_unavailable\` / \`504 upstream_timeout\`: the gateway could not reach the upstream, or it did not answer
  in time (30 s by default). Tell the operator.
- Every response has an \`x-request-id\` header; search it in [Logs](/logs) ("Request ID or path…").

## Signing in

- Register and sign in at the login page; registering signs you in at once. The operator can close registration
  (\`REGISTRATION_OPEN=false\`); invite links still work.
- **Forgot password?** on the login page mails a reset link if the operator set up \`SMTP_*\`; otherwise the link is
  printed in the server log for the operator.
- Members sign in with their username and cannot reset by email: the owner removes and re-invites them.

## Self-hosting (for the operator)

Point operators at the guides; do not give server commands beyond what this manual shows.
- Run it locally: [Getting started](${DOCS}/docs/getting-started.md).
- Deploy on a VPS: [Deploy on a VPS](${DOCS}/README.md#deploy-on-a-vps-10-minutes)
  and the [Hostinger deploy guide](${DOCS}/deploy/hostinger.md).
- Server settings (environment variables) are the operator's: a workspace owner cannot change them from the
  dashboard.

## This help assistant

It answers from this manual only, one question at a time (it does not see earlier questions), and does not see
your accounts, fans, logs or data. It cannot change anything for you. Each workspace gets 100 questions to the AI
per UTC day, failed ones included; after that it answers again after midnight UTC. Each user can ask 10 a minute.

## Not supported

Things people ask for that the product does not do, each with the closest supported feature:
- Designing your own stats page (choosing metrics, arranging widgets): not supported. Closest: the fixed cards on
  [Stats](/stats), its **Raw data** with CSV export, and the \`/v1/stats\` routes in the [API reference](/docs).
- Showing an API key's secret again: not supported. Closest: create a new key on [API keys](/keys) and revoke the
  old one.
- Key expiry dates or a per-key rate limit: not supported. Closest: **Revoke** on [API keys](/keys); the rate limit
  is one server-wide setting.
- Inviting by email, or changing a member's username: not supported. Closest: invite links on [Team](/team); remove
  and re-invite to change a username.
- A member creating API keys, webhooks or connecting accounts: not supported, those are owner-only. Closest: the
  member asks the owner, or uses the [Playground](/playground) within their features.
- Several workspaces per user, or switching workspaces: not supported. Each user belongs to one workspace.
- Changing the workspace slug: not supported. Closest: rename the workspace on [Settings](/settings).
- Stopping an analytics run from the dashboard: not supported (there is no stop button); it ends on its own. Only a
  command-line backfill run by the operator can be stopped
  ([Stopping](${DOCS}/docs/analytics-backfill.md#stopping)).
- Webhooks to plain \`http://\` URLs: not supported unless the operator allows them on the server (meant for local
  testing); use an \`https://\` URL.
- Sending messages or posts from a dashboard page: there is no such page. Closest: call the matching operation from
  the [Playground](/playground) or the API.
- A dark mode switch, two-factor sign-in or single sign-on: not supported.
- Questions about a specific fan, account or request: this assistant cannot see your data. Closest: [Logs](/logs),
  [Conversations](/conversations) or [Stats](/stats).
`;
