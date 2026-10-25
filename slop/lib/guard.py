"""Loopback-only network guard for a slop Python process (the upstream launcher and the scenario).

install(log_path) patches, in this process only:
  * socket.getaddrinfo: a name other than localhost / a loopback literal raises socket.gaierror;
  * socket.socket.connect / connect_ex: an AF_INET/AF_INET6 address off loopback raises OSError
    (asyncio, urllib, websockets and httpx all connect through these);
  * curl_cffi.requests.Session/AsyncSession.request: a URL or proxy whose host is not loopback raises
    (curl_cffi resolves and connects in libcurl, below the Python socket layer).
Every refusal is appended to `log_path` (JSONL: kind, host, stack tail), so a run can prove nothing tried
to leave the machine. Not covered (declared): child processes (Playwright's node driver, Chromium). The
Chromium the fake Browserbase launches resolves every host but onlyfans.com to NOTFOUND itself.
"""
from __future__ import annotations

import ipaddress
import json
import socket
import threading
import time
import traceback
from urllib.parse import urlsplit

_LOOPBACK_NAMES = {"localhost", "localhost.", "ip6-localhost"}
_lock = threading.Lock()
_log_path: str | None = None
_installed = False


def is_loopback(host: str | None) -> bool:
    if host is None or host == "":
        return True  # bind to any / unix path: nothing goes off-host
    h = str(host).strip("[]").lower()
    if h in _LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(h.split("%")[0]).is_loopback
    except ValueError:
        return False


def _refuse(kind: str, host: object) -> None:
    rec = {"t": time.time(), "kind": kind, "host": str(host),
           "stack": [ln.strip() for ln in traceback.format_stack(limit=8)[:-2]][-4:]}
    if _log_path:
        with _lock, open(_log_path, "a") as f:
            f.write(json.dumps(rec) + "\n")


def install(log_path: str) -> None:
    global _log_path, _installed
    _log_path = log_path
    if _installed:
        return
    _installed = True

    real_gai = socket.getaddrinfo

    def guarded_gai(host, *a, **kw):
        h = host.decode() if isinstance(host, bytes) else host
        if not is_loopback(h):
            _refuse("getaddrinfo", h)
            raise socket.gaierror(socket.EAI_NONAME, f"slop guard: {h} is off-host")
        return real_gai(host, *a, **kw)

    socket.getaddrinfo = guarded_gai

    def _check(addr) -> None:
        if isinstance(addr, tuple) and addr and isinstance(addr[0], str) and not is_loopback(addr[0]):
            _refuse("connect", addr[0])
            raise OSError(f"slop guard: connect to {addr[0]} is off-host")

    real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex

    def connect(self, addr):
        _check(addr)
        return real_connect(self, addr)

    def connect_ex(self, addr):
        _check(addr)
        return real_connect_ex(self, addr)

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex

    try:
        from curl_cffi import requests as cffi
    except Exception:  # noqa: BLE001 — not every process has it
        return

    def _check_url(method, url, kw):
        host = urlsplit(str(url)).hostname
        if not is_loopback(host):
            _refuse("curl_cffi", host)
            raise cffi.exceptions.ConnectionError(f"slop guard: {host} is off-host")
        for p in (kw.get("proxies") or {}).values() if isinstance(kw.get("proxies"), dict) else []:
            ph = urlsplit(str(p)).hostname if p else None
            if p and not is_loopback(ph):
                _refuse("curl_cffi-proxy", ph)
                raise cffi.exceptions.ProxyError(f"slop guard: proxy {ph} is off-host")

    for cls in (cffi.Session, getattr(cffi, "AsyncSession", None)):
        if cls is None:
            continue
        real = cls.request

        if cls is cffi.Session:
            def request(self, method, url, *a, _real=real, **kw):
                _check_url(method, url, kw)
                if getattr(self, "proxies", None):
                    _check_url(method, url, {"proxies": dict(self.proxies)})
                return _real(self, method, url, *a, **kw)
        else:
            async def request(self, method, url, *a, _real=real, **kw):
                _check_url(method, url, kw)
                return await _real(self, method, url, *a, **kw)
        cls.request = request
