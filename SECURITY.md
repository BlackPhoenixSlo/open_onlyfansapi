# Security policy

## Reporting a vulnerability

Report privately to **security@example.com** *(replace this with your own address before publishing)*.
Please do not open a public issue, pull request or discussion for a security problem.

Include what you can:

- the version or commit you tested,
- how the gateway was deployed (local `pnpm dev`, Docker, compose),
- the steps or a request sequence that shows the issue,
- what an attacker gains.

Expect an acknowledgement within a few days. There is no bug bounty. Please give a reasonable window for
a fix before disclosing publicly; credit in the release notes if you'd like it.

Only the latest commit on `main` is supported. This is pre-1.0 software: there are no backports.

## In scope

- The gateway API (`apps/api`): authentication, API keys, scopes, account allowlists, the proxy to the
  upstream backend, request logs, usage.
- The dashboard (`apps/web`) served by the gateway.
- The self-host packaging: `docker-compose.yml`, `docker/`, `.env.example` and the documented defaults.

## Out of scope

- The upstream creator-account backend and the content platforms behind it — report those to their owners.
- Anything caused by running with secrets, debug settings or a database exposed on purpose, and findings
  that need an operator or host-level compromise you already have.
- Missing hardening headers or rate limits on a deployment you control, dependency advisories with no
  reachable path in this code, and automated scanner output without a working reproduction.

## Threat summary

A few properties worth knowing when you look for issues:

- **The gateway holds one upstream credential.** It signs short-lived JWTs for the backend with a single
  secret from the environment (`BACKEND_JWT_SECRET`). Compromising the gateway process or its `.env`
  means every workspace's upstream access, so anything that leaks environment values, lets a tenant reach
  another tenant's accounts, or escapes the proxy path prefix is serious.
- **API keys are stored hashed.** A key is shown once at creation; only its SHA-256 hash and prefix are in
  the database, so the table alone does not yield usable keys. A key carries scopes and an optional
  account allowlist, and revocation is immediate.
- **Cookie-authenticated writes need `Origin` *and* a header.** Dashboard requests must send
  `Origin: $APP_URL` and `x-dashboard: 1`; a bearer token always wins over a cookie, and an invalid bearer
  is a 401 with no cookie fallback. Bypassing that pair is a CSRF finding.
- **Tenant isolation** is enforced by `team_id` on every table and query. Cross-tenant reads or writes are
  the highest-severity class here.
- **Logs may hold request and response bodies.** `LOG_BODIES=errors` by default (status ≥ 400 only), with
  query strings and known secret-ish keys redacted before truncation. Gaps in that redaction are in scope.
