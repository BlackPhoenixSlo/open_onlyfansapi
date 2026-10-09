"""
Proxy registry — persistent store of per-account proxies.

Each account (or, legacy, each session JSON) can be paired with a proxy in
this registry by label. OFClient consults `get_for_account(account_id)` on
load and routes all curl_cffi traffic through it.

Single source of truth lives in $UPSTREAM_STATE_DIR/proxies.json (written
0600 — it holds proxy passwords). Schema:

  {
    "proxies": [
      {
        "label":              "acct-1",
        "scheme":             "http",      // http | https | socks5
        "host":               "203.0.113.10",
        "port":               8080,
        "username":           "...",       // optional
        "password":           "...",       // optional — plain text, see notes
        "notes":              "free text",
        "assigned_session":   "session_<ts>.json",  // or null
        "verified_ip":        "203.0.113.10",
        "verified_at":        "2026-01-01T00:00:00Z",
        "verified_geo":       "City, Region, CC"
      }
    ]
  }

Credentials are stored in plain text; the file mode (0600) and the state
dir mode (0700) are the protection.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import PROXIES_PATH, STATE_DIR, ensure_dir


_lock = threading.Lock()


def _empty() -> dict[str, Any]:
    return {"proxies": []}


def load() -> dict[str, Any]:
    if not PROXIES_PATH.exists():
        return _empty()
    try:
        data = json.loads(PROXIES_PATH.read_text())
    except json.JSONDecodeError:
        return _empty()
    if not isinstance(data, dict) or "proxies" not in data:
        return _empty()
    return data


def save(data: dict[str, Any]) -> None:
    """Write atomically: a temp file in the same dir (mkstemp creates it
    0600), then os.replace() over the target, so readers never see a torn
    file. The temp file is removed if anything fails before the replace."""
    ensure_dir(STATE_DIR)
    fd, tmp = tempfile.mkstemp(dir=STATE_DIR, prefix=".proxies.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, sort_keys=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, PROXIES_PATH)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def list_proxies() -> list[dict[str, Any]]:
    return load().get("proxies", [])


def get_by_label(label: str) -> dict[str, Any] | None:
    for p in list_proxies():
        if p.get("label") == label:
            return p
    return None


def get_for_session(session_filename: str) -> dict[str, Any] | None:
    """Return the proxy currently assigned to `session_filename`, or None.
    Legacy: pre-multi-account installs bound proxies to a specific session
    file. New installs bind to account_id (see `get_for_account`)."""
    for p in list_proxies():
        if p.get("assigned_session") == session_filename:
            return p
    return None


def _ids_on(p: dict[str, Any]) -> list[str]:
    """Return the list of account ids bound to this proxy.

    Reads the canonical `assigned_account_ids` list and, for legacy entries
    written before multi-binding was supported, falls back to the singular
    `assigned_account_id`. Callers should treat the result as a set."""
    ids = p.get("assigned_account_ids")
    if isinstance(ids, list) and ids:
        return [str(x) for x in ids]
    legacy = p.get("assigned_account_id")
    return [str(legacy)] if legacy else []


def get_for_account(account_id: str) -> dict[str, Any] | None:
    """Return the proxy assigned to this OF account (preferred — survives
    re-captures because each new session is bucketed under the same id).

    Each account belongs to at most ONE proxy (enforced in `assign_account`);
    a proxy may serve many accounts (and the picker flags >1 with a shared-
    egress warning, because OF can correlate same-IP accounts)."""
    if not account_id:
        return None
    aid = str(account_id)
    for p in list_proxies():
        if aid in _ids_on(p):
            return p
    return None


def proxy_url(p: dict[str, Any]) -> str:
    """Render a proxy entry to the URL form curl_cffi/requests expects."""
    scheme = p.get("scheme", "http")
    host, port = p["host"], p["port"]
    user, pw = p.get("username"), p.get("password")
    if user and pw:
        return f"{scheme}://{user}:{pw}@{host}:{port}"
    return f"{scheme}://{host}:{port}"


def proxies_dict_for_requests(p: dict[str, Any]) -> dict[str, str]:
    """Shape curl_cffi.requests.Session.proxies wants."""
    u = proxy_url(p)
    return {"http": u, "https": u}


def upsert(entry: dict[str, Any]) -> dict[str, Any]:
    """Add or update by label. Returns the stored entry.

    Updating an existing label replaces only the keys the caller passed: the
    `assigned_*` bindings, the last probe and anything else omitted are kept.
    (Defaulting them here once reset `assigned_account_ids` to [], which
    silently unbound every other account sharing the proxy.)"""
    label = entry.get("label")
    if not label:
        raise ValueError("proxy entry needs a 'label'")
    for required in ("host", "port"):
        if not entry.get(required):
            raise ValueError(f"proxy entry missing '{required}'")
    defaults = {
        "scheme": "http",
        "notes": "",
        "assigned_session": None,      # legacy per-file binding
        "assigned_account_id": None,   # legacy singular — mirrored from list[0]
        "assigned_account_ids": [],    # canonical: many-accounts-per-proxy
        "user_id": None,               # owner; null = shared default pool
        "verified_ip": None,
        "verified_at": None,
        "verified_geo": None,
    }

    with _lock:
        data = load()
        for i, p in enumerate(data["proxies"]):
            if p.get("label") == label:
                merged = {**p, **entry}
                data["proxies"][i] = merged
                save(data)
                return merged
        stored = {**defaults, **entry}
        data["proxies"].append(stored)
        save(data)
        return stored


def remove(label: str) -> bool:
    with _lock:
        data = load()
        before = len(data["proxies"])
        data["proxies"] = [p for p in data["proxies"] if p.get("label") != label]
        if len(data["proxies"]) == before:
            return False
        save(data)
        return True


def assign(label: str, session_filename: str | None) -> dict[str, Any]:
    """Bind a proxy to a session file (LEGACY). Prefer `assign_account`.
    Enforces 1:1 — if another proxy already owns that session, it is unassigned."""
    with _lock:
        data = load()
        target = None
        for p in data["proxies"]:
            if p.get("label") == label:
                target = p
            elif session_filename and p.get("assigned_session") == session_filename:
                p["assigned_session"] = None
        if target is None:
            raise KeyError(f"no proxy with label {label!r}")
        target["assigned_session"] = session_filename
        save(data)
        return target


def _sync_legacy_singular(p: dict[str, Any]) -> None:
    """Mirror `assigned_account_ids[0]` into the legacy `assigned_account_id`
    so older readers (any out-of-band tooling) still see
    SOMETHING when a proxy is bound. None when the list is empty."""
    ids = p.get("assigned_account_ids") or []
    p["assigned_account_id"] = str(ids[0]) if ids else None


def assign_account(label: str, account_id: str | None) -> dict[str, Any]:
    """Bind an OF account to a proxy. Each account belongs to AT MOST one
    proxy — if the account is currently bound to a different proxy, it is
    moved here. Many accounts may share the same proxy (the UI surfaces a
    warning when >1 share egress because OF can correlate same-IP behaviour).

    `account_id=None` is preserved as a no-op (the old "unbind the single
    binding" gesture moved to `unbind_account`); silently ignoring keeps
    legacy callers safe."""
    if account_id is None:
        # Existing callers (and the older UI) sometimes hit this with null
        # to express "unbind". With multi-binding, that gesture is ambiguous
        # (unbind WHICH account?) so the explicit `unbind_account` path
        # owns it. Look up the target so callers still get the proxy back.
        for p in list_proxies():
            if p.get("label") == label:
                return p
        raise KeyError(f"no proxy with label {label!r}")

    aid = str(account_id)
    with _lock:
        data = load()
        target = None
        for p in data["proxies"]:
            # Lift legacy singular into the list before mutating, so a
            # pre-multi-binding entry doesn't silently lose its original
            # binding when a second account is added.
            ids = _ids_on(p)
            if p.get("label") == label:
                target = p
                if aid not in ids:
                    ids.append(aid)
            else:
                # Account moves: drop it from every OTHER proxy. Same
                # invariant the old single-binding code enforced, just
                # expressed against a list.
                ids = [x for x in ids if x != aid]
            p["assigned_account_ids"] = ids
            _sync_legacy_singular(p)
        if target is None:
            raise KeyError(f"no proxy with label {label!r}")
        # Clear the legacy filename binding so the two don't fight each other.
        target["assigned_session"] = None
        save(data)
        return target


def unbind_account(label: str, account_id: str) -> dict[str, Any]:
    """Remove a single account from a proxy's binding list. Account is left
    without a proxy (falls back to direct egress until reassigned)."""
    aid = str(account_id)
    with _lock:
        data = load()
        target = None
        for p in data["proxies"]:
            if p.get("label") == label:
                target = p
                # Lift legacy singular into the list first so a pre-multi
                # entry can be unbound just like any other.
                ids = _ids_on(p)
                p["assigned_account_ids"] = [x for x in ids if x != aid]
                _sync_legacy_singular(p)
                break
        if target is None:
            raise KeyError(f"no proxy with label {label!r}")
        save(data)
        return target


def migrate_legacy_assignments(filename_to_account: dict[str, str]) -> int:
    """Promote `assigned_session` (filename) bindings into the per-account
    list using a {session_filename: account_id} map (built from the account
    dirs). Idempotent. Returns how many proxies were rebound.

    Also lifts any pre-multi-binding `assigned_account_id` value into the
    `assigned_account_ids` list so reads through the canonical accessor
    pick it up. The list is the source of truth; the singular stays
    mirrored for legacy readers."""
    rebound = 0
    with _lock:
        data = load()
        for p in data["proxies"]:
            # Lift legacy singular into the list if not yet migrated.
            ids = list(p.get("assigned_account_ids") or [])
            legacy = p.get("assigned_account_id")
            if legacy and str(legacy) not in [str(x) for x in ids]:
                ids.append(str(legacy))
                p["assigned_account_ids"] = ids
            if ids:
                _sync_legacy_singular(p)
                continue  # already on the new scheme
            sf = p.get("assigned_session")
            if sf and sf in filename_to_account:
                aid = str(filename_to_account[sf])
                p["assigned_account_ids"] = [aid]
                _sync_legacy_singular(p)
                # Don't clear assigned_session immediately — keep it as an audit
                # crumb so an admin can still see which capture originally
                # introduced this binding.
                rebound += 1
        if rebound:
            save(data)
    return rebound


def record_verification(label: str, *, ip: str | None, geo: str | None,
                        ok: bool, of_reachable: bool | None = None,
                        of_error: str | None = None) -> None:
    """Persist the last probe result for a proxy: its egress IP and geo, and
    whether it tunnels to onlyfans.com (`verified_of_reachable`, None = not checked)."""
    with _lock:
        data = load()
        for p in data["proxies"]:
            if p.get("label") == label:
                p["verified_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                p["verified_ip"] = ip if ok else None
                if ok:
                    p["verified_geo"] = geo
                p["verified_of_reachable"] = of_reachable
                p["verified_of_error"] = of_error
                save(data)
                return


OF_PROBE_URL = "https://onlyfans.com/"


def _redact(message: str, p: dict[str, Any]) -> str:
    return message.replace(p["password"], "***") if p.get("password") else message


def probe(p: dict[str, Any], timeout_s: int = 15, of_timeout_s: int = 10) -> dict[str, Any]:
    """Fetch the egress IP through the proxy, a coarse geo lookup (direct), and
    then onlyfans.com itself through the proxy: a proxy can tunnel to ipify
    yet refuse the CONNECT to onlyfans.com (`curl: (56) CONNECT tunnel failed,
    response 403`), which is what breaks OF traffic.
    Returns {ok, ip, geo, error, of_reachable, of_error}: `ok` = an IP was
    obtained; `of_reachable` = any HTTP answer from onlyfans.com (None when the
    IP step failed, so it was not tried). Errors never carry the password.
    Blocking (network): call it off the event loop.

    Goes through curl_cffi with `proxies_dict_for_requests` and the Chrome
    impersonation, the transport OF traffic uses, so socks5/socks5h proxies
    probe like http ones."""
    from curl_cffi import requests as cffi

    proxies = proxies_dict_for_requests(p)
    ip = None
    geo = None
    err = None
    of_reachable = None
    of_error = None
    try:
        r = cffi.get("https://api.ipify.org", proxies=proxies,
                     timeout=timeout_s, impersonate="chrome")
        r.raise_for_status()
        ip = r.text.strip() or None
        if ip is None:
            err = "proxy_probe_failed: empty answer from api.ipify.org"
    except Exception as e:
        err = _redact(f"proxy_probe_failed: {e}", p)

    if ip:
        try:
            info = cffi.get(f"https://ipinfo.io/{ip}/json", timeout=timeout_s).json()
            parts = [info.get("city"), info.get("region"), info.get("country")]
            geo = ", ".join(x for x in parts if x) or None
        except Exception:
            geo = None

        # Any HTTP status (200, a redirect, OF's own 403) means the tunnel opened.
        try:
            cffi.get(OF_PROBE_URL, proxies=proxies, timeout=of_timeout_s,
                     impersonate="chrome", allow_redirects=False)
            of_reachable = True
        except cffi.exceptions.RequestException as e:
            of_reachable = False
            of_error = _redact(str(e), p)[:300]

    return {"ok": ip is not None, "ip": ip, "geo": geo, "error": err,
            "of_reachable": of_reachable, "of_error": of_error}
