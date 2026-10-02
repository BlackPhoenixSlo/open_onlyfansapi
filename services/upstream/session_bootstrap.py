#!/usr/bin/env python3
"""
Session bootstrap from a pasted DevTools curl.

The caller pastes a single `curl ...` command from browser DevTools
("Network" tab → right-click a /api2/v2/* request → "Copy as cURL").
We parse:
  * cookies from the `-b '…'` flag
  * headers (user-id, x-bc, x-of-rev, user-agent, accept-language, sign,
    time) from -H flags
  * the URL → builds a sample (sha1Hex from sign + Time + URL + user_id)
Then we fetch 2313.js for the captured x-of-rev (through the account's
proxy when one is given) and derive checksum_indexes + checksum_constant
via of_signer.derive_rules_from_chunk.

`static_param` is per OF revision and cannot be read off the wire: pass it
in the bootstrap request, or set env `STATIC_PARAM`. A session already
captured at the same x-of-rev also supplies it.

CLI: python session_bootstrap.py paste-curl < curl.txt
"""
from __future__ import annotations

import json
import os
import re
import sys
import shlex
from datetime import datetime, timezone
from pathlib import Path

from curl_cffi import requests as cffi_requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import accounts as account_registry  # noqa: E402
from config import SESSIONS_DIR, ensure_dir  # noqa: E402
from of_client import IMPERSONATE  # noqa: E402
from of_signer import derive_rules_from_chunk, verify_rules  # noqa: E402

CHUNK_URL_TPL = "https://static2.onlyfans.com/static/prod/f/{rev}/2313.js"


# ─── paste-curl ───────────────────────────────────────────────────────

class CurlParseError(ValueError):
    pass


def parse_curl(curl_text: str) -> dict:
    """Parse a `curl ...` command (the kind DevTools generates).

    Returns:
      {
        "url":      str,
        "method":   "GET"|"POST"|...,
        "headers":  {lowercase_name: value, ...},
        "cookies":  [{"name", "value", "domain", "path"}, ...],
        "data":     str | None,
      }
    """
    # Normalise line continuations + dollar-quoted strings DevTools sometimes adds
    text = curl_text.strip()
    # Bash line continuations
    text = text.replace("\\\n", " ")
    # `$'…'` quoting → strip the $
    text = re.sub(r"\$('[^']*')", r"\1", text)

    try:
        tokens = shlex.split(text)
    except ValueError as e:
        raise CurlParseError(f"shell parse failed: {e}") from e

    if not tokens or tokens[0] != "curl":
        raise CurlParseError("expected the command to start with `curl`")

    url: str | None = None
    method = "GET"
    headers: dict[str, str] = {}
    cookies_raw = ""
    data: str | None = None

    i = 1
    while i < len(tokens):
        t = tokens[i]
        if t in ("-H", "--header"):
            i += 1
            kv = tokens[i]
            if ":" in kv:
                k, v = kv.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        elif t in ("-b", "--cookie"):
            i += 1
            cookies_raw = tokens[i]
        elif t in ("-X", "--request"):
            i += 1
            method = tokens[i].upper()
        elif t in ("-d", "--data", "--data-raw", "--data-binary", "--data-ascii"):
            i += 1
            data = tokens[i]
            if method == "GET":
                method = "POST"
        elif t.startswith(("--compressed", "--insecure", "-k", "--http2", "--http1.1")):
            pass
        elif t in ("-A", "--user-agent"):
            i += 1
            headers["user-agent"] = tokens[i]
        elif t in ("-e", "--referer"):
            i += 1
            headers["referer"] = tokens[i]
        elif t.startswith("-"):
            # Skip unknown flags + their possible arg. Best-effort.
            if i + 1 < len(tokens) and not tokens[i + 1].startswith("-") and not tokens[i + 1].startswith("http"):
                i += 1
        elif url is None:
            url = t
        i += 1

    if not url:
        raise CurlParseError("no URL found in command")

    cookies: list[dict] = []
    if cookies_raw:
        for pair in cookies_raw.split(";"):
            pair = pair.strip()
            if not pair or "=" not in pair:
                continue
            name, value = pair.split("=", 1)
            cookies.append({
                "name": name.strip(), "value": value.strip(),
                "domain": ".onlyfans.com", "path": "/",
                "expires": -1, "httpOnly": False, "secure": True, "sameSite": "None",
            })

    return {"url": url, "method": method, "headers": headers,
            "cookies": cookies, "data": data}


def from_curl(curl_text: str, *,
              static_param_override: str | None = None,
              proxy_url: str | None = None,
              account_id: str | None = None,
              nickname: str | None = None,
              make_active: bool = True) -> Path:
    """Build a complete session from a single DevTools curl command.

    The curl MUST be for a /api2/v2/* endpoint OF signs — it must have:
      -H 'user-id: ...', -H 'x-bc: ...', -H 'x-of-rev: ...',
      -H 'sign: start:sha1:hex:end', -H 'time: <ms>',
      -H 'user-agent: ...', -b 'cookies...'

    `static_param_override` is the static_param for the OF revision being
    pasted (the bootstrap request's `static_param`). If None, we look it up by
    x-of-rev in any existing session (static_param is per-OF-revision,
    identical for all users at that revision), then fall back to env
    `STATIC_PARAM`.

    `proxy_url` (e.g. http://user:pass@host:port) routes the 2313.js fetch
    through the account's proxy, the same egress its signed calls will use.
    """
    parsed = parse_curl(curl_text)
    h = parsed["headers"]
    required = ("user-id", "x-bc", "x-of-rev", "sign", "time", "user-agent")
    missing = [k for k in required if not h.get(k)]
    if missing:
        raise CurlParseError(
            f"curl is missing required signed-request headers: {missing}. "
            f"Make sure the curl was copied from a /api2/v2/* request, not a "
            f"static asset GET."
        )

    user_id = h["user-id"]
    x_bc = h["x-bc"]
    x_of_rev = h["x-of-rev"]
    user_agent = h["user-agent"]
    sign = h["sign"]
    time_ms = h["time"]

    # Optional runtime fields a capture tool may inject as custom -H headers.
    # The wire never carries these — they're only knowable from a hooked
    # webpack module on the live page.
    curl_static_param = h.get("x-relay-static-param")
    curl_sign_start   = h.get("x-relay-sign-start")
    curl_sign_end     = h.get("x-relay-sign-end")

    # Parse Sign: "start:sha1:hexchecksum:end"
    parts = sign.split(":")
    if len(parts) != 4:
        raise CurlParseError(f"Sign header malformed (need 4 colon-separated parts): {sign!r}")
    start, sha1Hex, hexchecksum, end = parts
    # Tool-supplied start/end act as cross-checks — if they
    # disagree with what's on the wire, the page state is inconsistent
    # and we'd rather fail loudly here than write a broken session.
    if curl_sign_start and curl_sign_start != start:
        raise CurlParseError(
            f"x-relay-sign-start ({curl_sign_start!r}) does not match the "
            f"start in the Sign header ({start!r}) — page state is inconsistent"
        )
    if curl_sign_end and curl_sign_end != end:
        raise CurlParseError(
            f"x-relay-sign-end ({curl_sign_end!r}) does not match the "
            f"end in the Sign header ({end!r}) — page state is inconsistent"
        )
    try:
        checksum_value = abs(int(hexchecksum, 16))
    except ValueError as e:
        raise CurlParseError(f"hex checksum portion is not hex: {hexchecksum!r}") from e

    sample = {"sha1Hex": sha1Hex, "checksumValue": checksum_value,
              "url": parsed["url"], "time": time_ms, "user_id": user_id}

    # ── Get static_param ─────────────────────────────────────
    # Priority:
    #   1. static_param_override (the bootstrap request's `static_param`)
    #   2. Per-curl x-relay-static-param header, if a capture tool added one
    #   3. Cross-session lookup by x-of-rev (works once any account has
    #      already been captured at the current rev)
    #   4. env STATIC_PARAM
    static_param = static_param_override or curl_static_param
    if not static_param:
        static_param = _lookup_static_param_for_rev(x_of_rev)
    if not static_param:
        static_param = os.environ.get("STATIC_PARAM") or None
    if not static_param:
        raise CurlParseError(
            f"static_param is required for x-of-rev {x_of_rev!r}: pass the "
            f"`static_param` field in the bootstrap request, or set env "
            f"STATIC_PARAM."
        )

    # ── Fetch 2313.js + derive checksum indexes/constant ─────
    chunk_url = CHUNK_URL_TPL.format(rev=x_of_rev)
    print(f"[bootstrap] Fetching {chunk_url}" + (" via proxy" if proxy_url else ""))
    r = cffi_requests.get(
        chunk_url,
        impersonate=IMPERSONATE,
        headers={"User-Agent": user_agent, "Referer": "https://onlyfans.com/"},
        proxies={"http": proxy_url, "https": proxy_url} if proxy_url else None,
        timeout=20,
    )
    r.raise_for_status()
    chunk_code = r.content.decode("utf-8", errors="replace")
    print(f"[bootstrap] Got chunk ({len(chunk_code)} bytes)")

    derived = derive_rules_from_chunk(chunk_code, [sample])
    if not derived:
        raise RuntimeError(
            "Could not derive checksum_indexes/constant from chunk. OF may "
            "have changed obfuscation; update _NUM5_* regexes in of_signer.py."
        )

    rules = {
        "static_param": static_param,
        "start": start,
        "end": end,
        "checksum_indexes": derived["checksum_indexes"],
        "checksum_constant": derived["checksum_constant"],
    }
    # Sanity: verify rules against the very sample we built
    ok, _ = verify_rules(rules, [sample])
    if not ok:
        raise RuntimeError(
            "Derived rules failed to reproduce the captured Sign. The "
            "static_param value is likely wrong for this OF revision."
        )
    print("[bootstrap] Rules verified against the captured sample.")

    # ── Persist session into the right account dir ───────────
    adir = ensure_dir(account_registry.account_dir(user_id))
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    chunk_file = f"chunk_2313_{ts}.js"
    (adir / chunk_file).write_text(chunk_code)

    dump = {
        "captured_at": ts,
        "profile_id": "paste-curl",
        "page_url": parsed["url"],
        "headers": {
            "user_id": user_id, "x_bc": x_bc,
            "x_of_rev": x_of_rev, "user_agent": user_agent,
            "accept_language": h.get("accept-language"),
        },
        "signing": {
            "rules": rules,
            "samples": [sample],
            "last_sign_seen": sign,
            "last_time_seen": int(time_ms),
            "chunk_2313_url": chunk_url,
            "chunk_2313_file": chunk_file,
        },
        "cookies": parsed["cookies"],
        "local_storage": {},
    }
    session_path = adir / f"session_{ts}.json"
    session_path.write_text(json.dumps(dump, indent=2))
    account_registry.record_session(user_id, session_path)
    # account_id arg is treated as a hint only — the real binding is by user_id
    # (OF's identity), so pasting a different user's curl never silently
    # clobbers another account. We just persist nickname / activate if asked.
    account_registry.upsert_account(user_id, nickname=nickname)
    if make_active:
        account_registry.set_active_account_id(user_id)
    if account_id and account_id != user_id:
        print(f"[bootstrap] Note: requested account_id={account_id!r} but "
              f"the pasted curl belongs to user_id={user_id!r} — routed to "
              f"the correct account.")
    print(f"[bootstrap] Saved {session_path.relative_to(SESSIONS_DIR.parent)}")
    return session_path


# ─── helpers ─────────────────────────────────────────────────────────────

def _lookup_static_param_for_rev(x_of_rev: str) -> str | None:
    """Scan existing session files (across every account dir); return the
    first static_param that came from this OF revision. static_param is
    per-revision and identical across all users, so any account that has
    captured at this revision lets the paste-curl flow reuse the constant.
    """
    if not SESSIONS_DIR.is_dir():
        return None
    candidates: list[Path] = []
    # Per-account dirs
    accounts_dir = SESSIONS_DIR / "accounts"
    if accounts_dir.is_dir():
        for adir in accounts_dir.iterdir():
            if adir.is_dir():
                candidates.extend(adir.glob("session_*.json"))
    # Legacy flat dir (pre-migration, in case)
    candidates.extend(SESSIONS_DIR.glob("session_*.json"))
    for f in candidates:
        try:
            s = json.loads(f.read_text())
            if s.get("headers", {}).get("x_of_rev") != x_of_rev:
                continue
            sp = s.get("signing", {}).get("rules", {}).get("static_param")
            if sp:
                return sp
        except Exception:
            continue
    return None


# ─── CLI ─────────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    mode = argv[1]
    if mode == "paste-curl":
        # Read curl from stdin
        curl = sys.stdin.read()
        from_curl(curl)
        return 0
    print(f"Unknown mode: {mode}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
