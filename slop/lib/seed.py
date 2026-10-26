"""Seeding for scenarios with volume, run before any service starts (`Stack(seed=...)`):

  * `workspaces_sql(...)`: workspaces as sign-up leaves them (user, credential account with better-auth's own
    scrypt hash, organization, owner member, team_backend link), plus the accounts each owns (account_workspace)
    and API keys (api_key, key_hash = sha256 of the secret, as plugins/actor.ts hashes it);
  * `mass_sql(...)`: history the API serves: event ledger rows (/v1/stats), message_fact rows (analytics) and
    request_log rows (the dashboard's Home and Logs), all dated before the run, set-based with generate_series;
  * `write_upstream_session(...)`: the upstream's own session store for one account (accounts/<id>/meta.json,
    latest.json, session_<ts>.json and the chunk file), in the layout session_bootstrap.from_curl writes, signed
    with the fake world's synthetic rules. Declared: this seeds the upstream's store instead of driving a login.

Everything after seeding goes through real endpoints."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


def better_auth_hash(password: str, salt_hex: str | None = None) -> str:
    """better-auth's password hash (@better-auth/utils/password): scrypt N=16384 r=16 p=1 dkLen=64 over the
    NFKC password, salted with the hex salt string's bytes; stored as `<salt hex>:<key hex>`."""
    import unicodedata

    salt = salt_hex or os.urandom(16).hex()
    key = hashlib.scrypt(unicodedata.normalize("NFKC", password).encode(), salt=salt.encode(), n=16384, r=16, p=1,
                         dklen=64, maxmem=128 * 16384 * 16 * 2 + 1024 * 1024)
    return f"{salt}:{key.hex()}"


def key_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def q(v) -> str:
    """A SQL literal (seed values are the harness's own; quoting is for correctness, not trust)."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int | float):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def workspaces_sql(workspaces: list[dict]) -> str:
    """Each workspace: {team_id, slug, name, owner: {id, email, name, password_hash}, accounts: [int],
    keys: [{id, name, secret, scope}]}."""
    out = ["begin;"]
    for w in workspaces:
        o = w["owner"]
        out += [
            (f"insert into \"user\" (id, name, email, email_verified, created_at, updated_at) values "
             f"({q(o['id'])}, {q(o['name'])}, {q(o['email'])}, true, now() - interval '30 days', now());"),
            (f"insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values "
             f"({q('acc-' + o['id'])}, {q(o['id'])}, 'credential', {q(o['id'])}, {q(o['password_hash'])}, now(), now());"),
            (f"insert into organization (id, name, slug, created_at) values "
             f"({q(w['team_id'])}, {q(w['name'])}, {q(w['slug'])}, now() - interval '30 days');"),
            (f"insert into member (id, organization_id, user_id, role, created_at) values "
             f"({q('mem-' + o['id'])}, {q(w['team_id'])}, {q(o['id'])}, 'owner', now());"),
            f"insert into team_backend (team_id) values ({q(w['team_id'])});",
        ]
        out += [f"insert into account_workspace (account_id, team_id) values ({a}, {q(w['team_id'])});"
                for a in w["accounts"]]
        out += [f"insert into api_key (id, team_id, name, start, key_hash, scope, created_by) values "
                f"({q(k['id'])}, {q(w['team_id'])}, {q(k['name'])}, {q(k['secret'][:12])}, {q(key_hash(k['secret']))}, "
                f"{q(k['scope'])}, {q(o['id'])});" for k in w["keys"]]
    out.append("commit;")
    return "\n".join(out)


def mass_sql(workspaces: list[dict], *, events_per_account: int, messages_per_account: int,
             logs_per_workspace: int, days: int = 20) -> str:
    """History before the run. Events: tips.received (with an amount), subscriptions.new and messages.received in
    rotation, spread over the last `days` days (dedup_key null: none collides with a live event)."""
    out = ["begin;"]
    for w in workspaces:
        team = q(w["team_id"])
        for a in w["accounts"]:
            out.append(
                f"insert into event (id, account_id, type, amount_cents, dedup_key, created_at) "
                f"select 'evt_seed' || {a} || '_' || g, {a}, "
                f"(array['tips.received','subscriptions.new','messages.received'])[1 + g % 3], "
                f"case when g % 3 = 0 then 500 + g % 7 * 100 end, null, "
                f"now() - interval '1 hour' - (g % ({days} * 24)) * interval '1 hour' "
                f"from generate_series(1, {events_per_account}) g;")
            out.append(
                f"insert into message_fact (team_id, account_id, message_id, chat_id, direction, created_at, is_mass, "
                f"is_automated, price_cents, is_tip, tip_cents, is_opened, media_count, raw, fetched_at) "
                f"select {team}, {a}, g, {a}::bigint * 10 + g % 6, "
                f"case when g % 2 = 0 then 'outbound' else 'inbound' end, "
                f"now() - interval '1 day' - g * interval '7 minutes', false, false, 0, false, 0, false, 0, "
                f"jsonb_build_object('id', g, 'text', 'seeded message ' || g), now() - interval '1 day' "
                f"from generate_series(1, {messages_per_account}) g;")
        first = w["accounts"][0]
        key = q(w["keys"][0]["id"])
        out.append(
            f"insert into request_log (id, team_id, api_key_id, account_id, method, path, endpoint, ip, status_code, "
            f"duration_ms, req_bytes, resp_bytes, error_code, req_headers, created_at) "
            f"select 'req_seed' || {q(w['slug'])} || '_' || g, {team}, {key}, {first} + g % {len(w['accounts'])}, 'GET', "
            f"'/v1/' || ({first} + g % {len(w['accounts'])}) || '/chats', 'chats.list', '127.0.0.1', "
            f"case when g % 25 = 0 then 404 else 200 end, 20 + g % 180, 0, 512, "
            f"case when g % 25 = 0 then 'not_found' end, '{{}}'::jsonb, "
            f"now() - interval '2 hours' - g * interval '1 minute' from generate_series(1, {logs_per_workspace}) g;")
    out.append("commit;")
    return "\n".join(out)


def write_upstream_session(state: Path, uid: str, *, rules: dict, chunk: str, rev: str, username: str, name: str,
                           nickname: str, ts: str = "20261026T000000Z") -> None:
    adir = state / "sessions" / "accounts" / uid
    adir.mkdir(parents=True, exist_ok=True, mode=0o700)
    chunk_file = f"chunk_2313_{ts}.js"
    (adir / chunk_file).write_text(chunk)
    session = {
        "captured_at": ts, "profile_id": "slop-seed", "page_url": "https://onlyfans.com/my/chats",
        "headers": {"user_id": uid, "x_bc": "slop-x-bc-0123456789abcdef", "x_of_rev": rev,
                    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like "
                                  "Gecko) Chrome/141.0.0.0 Safari/537.36", "accept_language": "en-US,en;q=0.9"},
        "signing": {"rules": rules, "samples": [], "chunk_2313_url": None, "chunk_2313_file": chunk_file},
        "cookies": [{"name": "auth_id", "value": uid, "domain": ".onlyfans.com", "path": "/"}],
        "local_storage": {},
    }
    (adir / f"session_{ts}.json").write_text(json.dumps(session, indent=2))
    (adir / "meta.json").write_text(json.dumps({
        "id": uid, "nickname": nickname, "color": "#7C5CFF", "incogniton_profile_id": None, "platform": "onlyfans",
        "name": name, "username": username, "avatar": None, "created_at": "2026-10-01T00:00:00Z",
        "last_used_at": "2026-10-26T00:00:00Z"}, indent=2))
    (adir / "latest.json").write_text(json.dumps({"session": f"session_{ts}.json", "ts": ts}, indent=2))
