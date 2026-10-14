"""The post-capture tail shared by every sanctioned capture source (plan direct-login §B).

A session captured by any method — the pasted-cURL bootstrap (`app._bootstrap`) or the
remote-browser login (`browser_login`) — ends the same way: validate it with `OFClient.me()`
*through the bound proxy* (rolling the account back on failure), bind the account's own proxy,
evict the pooled client, persist the OF profile into `meta.json`, and build the
`accounts.connected` / `accounts.reconnected` frame. Factoring it here keeps the two sources
byte-for-byte identical and avoids an import cycle (this module imports only leaf modules, never
`app`; the supervisor is passed in).

The frame is returned, not published: publishing and `supervisor.reconcile()` stay on the async
route layer that owns the event loop.
"""
from __future__ import annotations

import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import accounts
import client_pool
import events
import proxies
import proxy_stats
from of_client import OFClient

log = logging.getLogger("upstream.session_commit")

_ENDPOINT_KEYS = ("scheme", "host", "port", "username", "password")

# from_curl rewrites these in place; everything else it writes is a new file.
_REWRITTEN = ("latest.json", "meta.json")


def bind_own_proxy(uid: str, entry: dict) -> None:
    """Store `entry` (from a proxy-line/URL parse) as the account's own `acct-<uid>` proxy and move
    the account onto it.

    The upsert keeps the accounts already bound to `acct-<uid>` (uid included), and until the assign
    `uid` stays on its previous proxy, so it never runs unproxied in between. A changed endpoint drops
    the last probe and the traffic counters: they described the old one."""
    label = f"acct-{uid}"
    old = proxies.get_by_label(label)
    if old is not None and any(str(old.get(k) or "") != str(entry.get(k) or "") for k in _ENDPOINT_KEYS):
        entry = {**entry, "verified_ip": None, "verified_at": None, "verified_geo": None,
                 "verified_of_reachable": None, "verified_of_error": None}
        proxy_stats.clear(label)
    proxies.upsert({"label": label, **entry})
    proxies.assign_account(label, uid)


def snapshot_account(uid: str) -> tuple[set[str], dict[str, tuple[bytes, int, int]]] | None:
    """The account dir's file names, plus latest.json's and meta.json's bytes and
    (atime, mtime) in ns; None when the account has no dir yet."""
    adir = accounts.account_dir(uid)
    try:
        names = {p.name for p in adir.iterdir()}
    except FileNotFoundError:
        return None
    kept = {}
    for name in _REWRITTEN:
        if name in names:
            st = (adir / name).stat()
            kept[name] = (adir / name).read_bytes(), st.st_atime_ns, st.st_mtime_ns
    return names, kept


def rollback_account(uid: str, snapshot: tuple[set[str], dict[str, tuple[bytes, int, int]]] | None) -> None:
    """Undo a failed capture: a new account is deleted outright; otherwise delete every
    file it created (session, chunk) and put latest.json and meta.json back byte- and
    mtime-exact, so the pump key (and an expired session's mark) and the nickname are
    unchanged."""
    if snapshot is None:
        accounts.delete_account(uid)
        return
    adir = accounts.account_dir(uid)
    names, kept = snapshot
    for p in adir.iterdir():
        if p.name not in names:
            p.unlink(missing_ok=True)
    for name, (data, atime_ns, mtime_ns) in kept.items():
        (adir / name).write_bytes(data)
        os.utime(adir / name, ns=(atime_ns, mtime_ns))


def commit_captured_session(
    uid: str,
    *,
    session_path: Path,
    entry: dict[str, Any] | None,
    new_entry: dict[str, Any] | None,
    snapshot: tuple[set[str], dict[str, tuple[bytes, int, int]]] | None,
    had_session: bool,
    supervisor: Any,
) -> tuple[dict, dict]:
    """Validate a freshly written session with `me()` through its proxy, then commit the binding.

    `entry` is the proxy the session was minted through (used to build the validation client so the
    one-egress rule holds). `new_entry` is a proxy to persist as the account's own `acct-<uid>`
    (None leaves any existing binding alone). A failed validation restores the previous session.

    Returns the response body and the `accounts.connected` / `accounts.reconnected` frame
    (`reconnected` when the account already had a session). The caller publishes the frame and
    reconciles."""
    try:
        probe = OFClient.from_session_file(
            session_path,
            proxies=proxies.proxies_dict_for_requests(entry) if entry else None,
            proxy_label=entry.get("label") if entry else None,
        )
        me = probe.me()
    except Exception:
        log.warning("capture: me() failed for account=%s; previous session restored", uid)
        rollback_account(uid, snapshot)
        raise

    if new_entry is not None:
        bind_own_proxy(uid, new_entry)
    client_pool.evict(uid)
    meta = accounts.load_meta(uid) or {"id": uid}
    meta.update(username=me.get("username"), name=me.get("name"), avatar=me.get("avatar"))
    accounts.save_meta(uid, meta)
    key = supervisor.key(uid)
    assert key is not None, "capture wrote no session"
    frame = events.account_event(
        "accounts.reconnected" if had_session else "accounts.connected",
        int(uid), key[0], "authenticated", events.iso(datetime.now(UTC)),
    )
    return {"accountId": int(uid), "username": me.get("username")}, frame
