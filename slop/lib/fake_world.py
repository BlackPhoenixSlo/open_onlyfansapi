"""The outside world of the Browserbase login, on loopback. The upstream's own code runs unchanged
against it; the launcher (lib/upstream_launcher.py) points the upstream's module constants here.

  Browserbase API   plain HTTP `/v1/...` in Browserbase's shapes: POST /v1/sessions launches one fresh
                    local headless Chromium (Playwright's build, own profile, CDP on a loopback port;
                    `connectUrl` is its CDP ws URL), GET /v1/sessions/<id>/debug answers the live view
                    URL, POST /v1/sessions/<id> {status: REQUEST_RELEASE} stops that Chromium. The API key
                    must be the run's dummy key and captcha solving must be off.
  Live view         `/live/<sid>`: a page showing the session's tab (a CDP screenshot every second).
                    Bypass, declared: not Browserbase's interactive devtools page.
  The Chromium      `--host-resolver-rules` maps onlyfans.com to the fake OF site and every other host
                    to NOTFOUND; the self-signed certificate is accepted with --ignore-certificate-errors.
  OnlyFans' site    HTTPS on loopback, served for onlyfans.com: a login form rendered by script after
                    load; a 2FA prompt with a STALE HIDDEN `input[name=code]` ahead of the visible one;
                    for an account in `captchas`, the prompt also carries a reCAPTCHA frame: "hidden" (a
                    leftover, in a visibility:hidden container off screen, as reCAPTCHA parks its challenge)
                    or "visible" (on screen, next to the code field). Each frame load is recorded in
                    `captcha_frames` (uid, path);
                    a wrong code re-renders the prompt with an error; the right code sets `auth_id`, and
                    the signed-in home page makes one signed /api2/v2 request and loads the signing
                    module (webpack 89668) through `webpackChunkof_vue`. Every 2FA submission is recorded
                    (the visible field's value and the stale field's value) in `otp_record` and
                    `fake-of-otp-record.jsonl`: the wire boundary, the one place a code may appear.
  OnlyFans' API     plain HTTP on loopback, for the upstream after the login (of_client.API_BASE,
                    HASH_BASE, session_bootstrap.CHUNK_URL_TPL point here): the 2313.js chunk, the
                    x-hash, /api2/v2/users/me (the `sign` header is verified against the synthetic
                    rules; `wsUrl` points at the fake socket) and empty pages for the pollers' reads.
                    Bypass, declared: the upstream reaches it by IP, so its cookies (domain
                    .onlyfans.com) are not sent; it authenticates by the verified signature instead.
  OnlyFans' socket  ws on loopback: answers {"act":"connect"} with {"connected":true}, then idles.

Bypass, declared: the signing material is synthetic (`signing()`): a 2313.js with 32 checksum terms
and the sign it implies, so of_signer.derive_rules_from_chunk accepts it as it would OF's.
"""
from __future__ import annotations

import base64
import json
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / "services" / "upstream"
BB_KEY = "slop-browserbase-dummy-key"
BB_PROJECT = "slop-project"


def signing(uid: str, rev: str, time_ms: int) -> dict:
    """Synthetic OF signing material for `uid`: a 2313.js whose 32 checksum terms
    `of_signer.derive_rules_from_chunk` reads, the rules behind it, and the sign of
    GET /api2/v2/users/me at `time_ms` under those rules."""
    if str(UPSTREAM) not in sys.path:
        sys.path.insert(0, str(UPSTREAM))
    import of_signer

    bases = [10007 + 131 * k for k in range(32)]
    chunk = ("/* 2313.js (slop) */ (self.webpackChunkof_vue=self.webpackChunkof_vue||[]).push([[2313],{802313:"
             "function(e,t,n){t.A=function(W,a){return " + "".join(f"+a[{n}%W[0]](0)" for n in bases) + "}}}]);")
    rules = {"static_param": "slopStaticParam2026", "start": "41999", "end": "6a1b2c3d",
             "checksum_indexes": [n % 40 for n in bases], "checksum_constant": 2026}
    url = "https://onlyfans.com/api2/v2/users/me"
    signed = of_signer.sign(url, uid, rules, time_ms)
    return {"chunk": chunk, "rules": rules, "url": url, "rev": rev, "uid": uid,
            "x_bc": "slop-x-bc-0123456789abcdef", **signed}


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


_LOGIN_HTML = """<!doctype html><html><head><title>OnlyFans</title><style>
body{font-family:Helvetica,Arial,sans-serif;background:#f5f7f8;margin:0}
.box{max-width:380px;margin:80px auto;background:#fff;border-radius:8px;padding:28px;box-shadow:0 1px 4px #0002}
h1{color:#00aff0;font-size:26px;margin:0 0 18px}input{display:block;width:100%;box-sizing:border-box;margin:8px 0;
padding:12px;border:1px solid #ccd;border-radius:6px;font-size:16px}button{width:100%;padding:12px;border:0;
border-radius:24px;background:#00aff0;color:#fff;font-weight:700;font-size:15px;margin-top:8px}.err{color:#d33}
</style></head><body><div class=box id=app>Loading…</div><script>
const app = document.getElementById("app");
let captcha = null;  // "hidden" | "visible" | null: a reCAPTCHA frame on the 2FA prompt
const CAPTCHA = {
  hidden: '<div style="visibility:hidden;position:absolute;top:-10000px"><iframe src="/recaptcha/api2/bframe"></iframe></div>',
  visible: '<iframe src="/recaptcha/api2/anchor" width=304 height=78 style="border:0;display:block;margin:8px 0"></iframe>',
};
const post = (p, b) => fetch(p, {method: "POST", body: JSON.stringify(b)}).then((r) => r.json());
function showLogin() {
  app.innerHTML = '<h1>OnlyFans</h1><form id=login><input type=text name=email placeholder=Email>' +
    '<input type=password name=password placeholder=Password><button type=submit>LOG IN</button></form>';
  document.getElementById("login").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const j = await post("/__fake/login", {email: f.email.value, password: f.password.value});
    if (j.otp) { captcha = j.captcha; showOtp(""); } else app.insertAdjacentHTML("beforeend", "<p class=err>Wrong email or password</p>");
  };
}
function showOtp(err) {
  app.innerHTML = '<h1>Two-step verification</h1><p>Enter the code from your authenticator app.</p>' +
    (err ? '<p class=err>' + err + '</p>' : '') +
    '<input name=code id=stale style=display:none>' +  // a stale hidden code input, ahead of the real one
    '<form id=otp><input name=code id=visible autocomplete=one-time-code inputmode=numeric placeholder=Code>' +
    '<button type=submit>VERIFY</button></form>' + (CAPTCHA[captcha] || '');
  document.getElementById("otp").onsubmit = async (e) => {
    e.preventDefault();
    const j = await post("/__fake/otp", {code: document.getElementById("visible").value,
                                         stale: document.getElementById("stale").value});
    if (j.ok) location.href = "/"; else showOtp("Wrong code. Please try again.");
  };
}
if (window.__SIGNED_IN__) {
  app.innerHTML = "<h1>OnlyFans</h1><p>Home (signed in)</p>";
  const S = window.__SIGNED_IN__;
  // OF's SPA makes signed /api2/v2 calls on load, and its signing module (webpack id 89668, js-sha1) arrives in a
  // chunk; webpack calls its factory, then sign() hashes "static_param\\ntime\\npath\\nuser_id". This page stands in
  // for webpack's runtime only.
  fetch(S.url, {headers: {"user-id": S.uid, "x-bc": S.x_bc, "x-of-rev": S.rev, "sign": S.sign, "time": S.time}})
    .then((r) => r.text()).then(() => {
      const mods = {89668: function (module) { module.exports = function sha1(input) { return "slop-sha1"; }; }};
      (self.webpackChunkof_vue = self.webpackChunkof_vue || []).push([[89668], mods]);
      const m = {exports: {}};
      mods[89668](m, m.exports, null);
      m.exports([S.static_param, S.time, "/api2/v2/users/me", S.uid].join("\\n"));
      app.insertAdjacentHTML("beforeend", "<p>Chats loaded</p>");
    });
} else {
  setTimeout(showLogin, 400);  // OF renders its form after load
}
</script></body></html>"""

_LIVE_HTML = """<!doctype html><html><head><title>Browserbase live view (slop)</title><style>
body{margin:0;background:#111;color:#bbb;font:12px Helvetica}img{width:100%%;display:block}</style></head>
<body><div>Browserbase live view (slop stand-in) &middot; session %(sid)s</div><img id=s src="/live/%(sid)s.png">
<script>setInterval(() => { document.getElementById("s").src = "/live/%(sid)s.png?t=" + Date.now(); }, 1000);</script>
</body></html>"""


class World:
    """Fake Browserbase + fake OnlyFans (site, API, socket) for one run. `accounts` maps each OF email
    to its user id; every account has `password` and takes the 2FA code `otp`."""

    def __init__(self, out: Path, *, accounts: dict[str, str], otp: str, password: str, chromium: str,
                 rev: str = "202610251200-slop", captchas: dict[str, str] | None = None):
        self.out = Path(out)
        self.tmp = self.out / "fake-world"
        self.tmp.mkdir(parents=True, exist_ok=True)
        self.accounts, self.otp, self.password, self.chromium, self.rev = accounts, otp, password, chromium, rev
        self.captchas = captchas or {}        # OF email -> "hidden" | "visible": a reCAPTCHA frame on its 2FA prompt
        self.bb_key, self.bb_project = BB_KEY, BB_PROJECT
        now = int(time.time() * 1000)
        self.signs = {uid: signing(uid, rev, now) for uid in accounts.values()}
        self.rules = next(iter(self.signs.values()))["rules"]
        self.chunk = next(iter(self.signs.values()))["chunk"]
        self.bb_calls: list[dict] = []        # Browserbase API: {method, path, status}
        self.logins: list[dict] = []          # OF login form posts: {email, password_ok}
        self.otp_record: list[dict] = []      # 2FA submissions: {t, uid, code, stale, ok}
        self.captcha_frames: list[dict] = []  # reCAPTCHA frame loads on the 2FA prompt: {t, uid, path}
        self.api_calls: list[dict] = []       # the upstream's OF API calls: {path, uid, sign_ok}
        self.ws_connects: list[dict] = []
        self.sessions: dict[str, dict] = {}   # sid -> {proc, cdp, dir, ws, released}
        self._lock = threading.Lock()
        self._servers: list[ThreadingHTTPServer] = []
        self._ws_server = None
        self._log = open(self.out / "fake-world.log", "a", buffering=1)
        self._otp_file = open(self.out / "fake-of-otp-record.jsonl", "a", buffering=1)

    def log(self, msg: str) -> None:
        """The fake services' own log: never a code or a password."""
        self._log.write(f"{time.strftime('%H:%M:%S')} {msg}\n")

    # ── lifecycle ──
    def __enter__(self) -> World:
        cert, key = self.tmp / "of-cert.pem", self.tmp / "of-key.pem"
        subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
                        "-out", str(cert), "-days", "2", "-subj", "/CN=onlyfans.com"],
                       check=True, capture_output=True)
        site = ThreadingHTTPServer(("127.0.0.1", 0), self._site_handler())
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        site.socket = tls.wrap_socket(site.socket, server_side=True)
        bb = ThreadingHTTPServer(("127.0.0.1", 0), self._bb_handler())
        api = ThreadingHTTPServer(("127.0.0.1", 0), self._api_handler())
        for s in (site, bb, api):
            s.daemon_threads = True
            threading.Thread(target=s.serve_forever, daemon=True).start()
            self._servers.append(s)
        self.site_port, self.bb_port, self.api_port = (s.server_address[1] for s in (site, bb, api))
        self._start_ws()
        self.bb_api = f"http://127.0.0.1:{self.bb_port}/v1"
        self.of_api = f"http://127.0.0.1:{self.api_port}"
        self.log(f"up: site :{self.site_port} bb :{self.bb_port} api :{self.api_port} ws :{self.ws_port}")
        return self

    def __exit__(self, *_a) -> None:
        for sid in list(self.sessions):
            self._stop(sid)
        for s in self._servers:
            s.shutdown()
            s.server_close()
        if self._ws_server is not None:
            self._ws_server.shutdown()
        self._log.close()
        self._otp_file.close()

    def _start_ws(self) -> None:
        from websockets.sync.server import serve

        world = self

        def handler(ws):
            try:
                msg = json.loads(ws.recv(timeout=10))
                uid = next((u for u, s in world.signs.items() if msg.get("token") == f"slop-ws-{u}"), None)
                with world._lock:
                    world.ws_connects.append({"t": time.time(), "uid": uid, "act": msg.get("act")})
                world.log(f"ws connect uid={uid}")
                if uid is None:
                    ws.close(4001)
                    return
                ws.send(json.dumps({"connected": True, "v": "5.4.0"}))
                for _ in ws:  # idle; answer nothing to get_onlines
                    pass
            except Exception:  # noqa: BLE001 — a peer going away
                pass

        self._ws_server = serve(handler, "127.0.0.1", 0)
        self.ws_port = self._ws_server.socket.getsockname()[1]
        threading.Thread(target=self._ws_server.serve_forever, daemon=True).start()

    # ── the remote browser ──
    def _launch(self) -> dict:
        with self._lock:
            sid = f"slopbb{len(self.sessions) + 1:02d}"
            self.sessions[sid] = {"id": sid, "released": False, "proc": None}
        cdp, d = free_port(), Path(tempfile.mkdtemp(prefix=f"{sid}-", dir=self.tmp))
        proc = subprocess.Popen([
            self.chromium, "--headless=new", f"--remote-debugging-port={cdp}", "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={d}", "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors",
            "--disable-background-networking", "--disable-component-update", "--disable-sync",
            "--disable-features=OptimizationHints,MediaRouter,Translate", "--metrics-recording-only",
            f"--host-resolver-rules=MAP onlyfans.com 127.0.0.1:{self.site_port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
            "--window-size=1280,800", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        deadline = time.time() + 20
        while True:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{cdp}/json/version", timeout=2) as r:
                    ws = json.loads(r.read())["webSocketDebuggerUrl"]
                break
            except Exception:
                if time.time() > deadline:
                    proc.kill()
                    raise
                time.sleep(0.1)
        s = {"id": sid, "proc": proc, "cdp": cdp, "dir": d, "ws": ws, "released": False}
        with self._lock:
            self.sessions[sid] = s
        self.log(f"bb session {sid} chromium pid={proc.pid} cdp=:{cdp}")
        return s

    def _stop(self, sid: str) -> None:
        s = self.sessions.get(sid)
        if not s or s.get("proc") is None or s["proc"].poll() is not None:
            return
        s["proc"].terminate()
        try:
            s["proc"].wait(timeout=10)
        except subprocess.TimeoutExpired:
            s["proc"].kill()
        shutil.rmtree(s["dir"], ignore_errors=True)

    def _screenshot(self, sid: str) -> bytes | None:
        from websockets.sync.client import connect

        s = self.sessions.get(sid)
        if not s or s.get("proc") is None or s["proc"].poll() is not None:
            return None
        with urllib.request.urlopen(f"http://127.0.0.1:{s['cdp']}/json/list", timeout=2) as r:
            tabs = [t for t in json.loads(r.read()) if t.get("type") == "page"]
        if not tabs:
            return None
        with connect(tabs[0]["webSocketDebuggerUrl"], max_size=None, open_timeout=3) as ws:
            ws.send(json.dumps({"id": 1, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
            while True:
                msg = json.loads(ws.recv(timeout=5))
                if msg.get("id") == 1:
                    return base64.b64decode(msg["result"]["data"])

    # ── HTTP handlers ──
    @staticmethod
    def _base(world):
        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_a):
                pass

            def _send(self, code, body, ctype="application/json", headers=None):
                if isinstance(body, bytes):
                    raw = body
                elif isinstance(body, str):
                    raw = body.encode()
                else:
                    raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(raw)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw)

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                try:
                    return json.loads(self.rfile.read(n) or b"{}")
                except ValueError:
                    return {}

            def _cookie(self, name):
                for part in (self.headers.get("Cookie") or "").split(";"):
                    k, _, v = part.strip().partition("=")
                    if k == name:
                        return v
                return None

        return H

    def _bb_handler(self):
        world, Base = self, self._base(self)

        class H(Base):
            def _note(self, status):
                with world._lock:
                    world.bb_calls.append({"t": time.time(), "method": self.command, "path": self.path.split("?")[0],
                                           "status": status})
                world.log(f"bb {self.command} {self.path.split('?')[0]} -> {status}")

            def do_GET(self):
                path = self.path.split("?")[0]
                parts = path.strip("/").split("/")
                if path.startswith("/v1/sessions/") and path.endswith("/debug"):
                    if self.headers.get("X-BB-API-Key") != BB_KEY:
                        self._note(401)
                        return self._send(401, {"message": "Invalid API key"})
                    live = f"http://127.0.0.1:{world.bb_port}/live/{parts[2]}"
                    self._note(200)
                    return self._send(200, {"debuggerFullscreenUrl": live, "debuggerUrl": live, "pages": []})
                if path.startswith("/live/") and path.endswith(".png"):
                    try:
                        png = world._screenshot(parts[1][:-4])
                    except Exception:  # noqa: BLE001 — a tab mid-navigation; the next tick retries
                        png = None
                    return self._send(200, png, "image/png") if png else self._send(404, {"error": "no tab"})
                if path.startswith("/live/"):
                    return self._send(200, _LIVE_HTML % {"sid": parts[1]}, "text/html")
                self._send(404, {"error": "not found"})

            def do_POST(self):
                path = self.path.split("?")[0]
                body = self._body()
                if self.headers.get("X-BB-API-Key") != BB_KEY:
                    self._note(401)
                    return self._send(401, {"message": "Invalid API key"})
                if path == "/v1/sessions":
                    if body.get("browserSettings", {}).get("solveCaptchas") is not False:
                        self._note(400)
                        return self._send(400, {"message": "slop: captcha solving must be off"})
                    if body.get("projectId") != BB_PROJECT:
                        self._note(400)
                        return self._send(400, {"message": "slop: unknown project"})
                    s = world._launch()
                    self._note(201)
                    return self._send(201, {"id": s["id"], "connectUrl": s["ws"], "status": "RUNNING"})
                parts = path.strip("/").split("/")
                if len(parts) == 3 and parts[1] == "sessions" and body.get("status") == "REQUEST_RELEASE":
                    world.sessions.get(parts[2], {})["released"] = True
                    world._stop(parts[2])
                    self._note(200)
                    return self._send(200, {"id": parts[2], "status": "COMPLETED"})
                self._note(404)
                self._send(404, {"error": "not found"})

        return H

    def _site_handler(self):
        world, Base = self, self._base(self)

        class H(Base):
            def do_GET(self):
                path = self.path.split("?")[0]
                uid = self._cookie("auth_id")
                s = world.signs.get(uid or "")
                if path in ("/", ""):
                    html = _LOGIN_HTML
                    if s:
                        data = {k: s[k] for k in ("url", "uid", "x_bc", "rev", "sign", "time")}
                        data["static_param"] = s["rules"]["static_param"]
                        html = html.replace("<script>", f"<script>window.__SIGNED_IN__={json.dumps(data)};", 1)
                    return self._send(200, html, "text/html")
                if path.startswith("/recaptcha/"):
                    with world._lock:
                        world.captcha_frames.append({"t": time.time(), "uid": self._cookie("slop_login"), "path": path})
                    world.log(f"of captcha frame {path} uid={self._cookie('slop_login')}")
                    return self._send(200, '<body style="margin:0;font:14px Arial;border:1px solid #d3d3d3;'
                                           'background:#f9f9f9;height:76px;display:flex;align-items:center;'
                                           'padding-left:12px">&#9744; I\'m not a robot (slop reCAPTCHA)</body>',
                                      "text/html")
                if path == "/api2/v2/users/me" and s:
                    return self._send(200, {"id": int(s["uid"]), "username": f"slop{s['uid']}",
                                            "name": "Slop Creator", "isAuth": True})
                self._send(404 if s else 401, {"error": "not found"})

            def do_POST(self):
                body = self._body()
                if self.path == "/__fake/login":
                    uid = world.accounts.get(body.get("email") or "")
                    ok = bool(uid) and body.get("password") == world.password
                    with world._lock:
                        world.logins.append({"t": time.time(), "uid": uid, "password_ok": ok})
                    world.log(f"of login uid={uid} password_ok={ok}")
                    return self._send(200, {"otp": ok, "captcha": world.captchas.get(body.get("email") or "")},
                                      headers={"Set-Cookie": f"slop_login={uid}; Domain=onlyfans.com; Path=/; Secure"}
                                      if ok else None)
                if self.path == "/__fake/otp":
                    code, stale, uid = str(body.get("code") or ""), str(body.get("stale") or ""), self._cookie("slop_login")
                    ok = uid in world.signs and code == world.otp
                    rec = {"t": time.time(), "uid": uid, "code": code, "stale": stale, "ok": ok}
                    with world._lock:
                        world.otp_record.append(rec)
                    world._otp_file.write(json.dumps(rec) + "\n")
                    world.log(f"of 2fa submission uid={uid} len={len(code)} stale_len={len(stale)} ok={ok}")
                    return self._send(200, {"ok": ok},
                                      headers={"Set-Cookie": f"auth_id={uid}; Domain=onlyfans.com; Path=/; Secure"}
                                      if ok else None)
                self._send(404, {"error": "not found"})

        return H

    def _api_handler(self):
        world, Base = self, self._base(self)
        sys.path.insert(0, str(UPSTREAM)) if str(UPSTREAM) not in sys.path else None
        import of_signer

        class H(Base):
            def do_GET(self):
                path = self.path.split("?")[0]
                rev = {"x-of-rev": world.rev}
                if path.startswith("/static/prod/f/") and path.endswith("/2313.js"):
                    world.log(f"api GET {path}")
                    return self._send(200, world.chunk, "application/javascript")
                if path.startswith("/hash"):
                    world.log("api GET /hash")
                    return self._send(200, "slop-x-hash-0123", "text/plain")
                if path.startswith("/api2/v2/"):
                    uid = self.headers.get("user-id") or ""
                    s = world.signs.get(uid)
                    want = of_signer.sign(f"http://x{self.path}", uid, world.rules,
                                          int(self.headers.get("time") or 0))["sign"] if s else None
                    ok = bool(s) and self.headers.get("sign") == want and bool(self.headers.get("x-hash"))
                    with world._lock:
                        world.api_calls.append({"t": time.time(), "path": path, "uid": uid, "sign_ok": ok})
                    world.log(f"api GET {path} uid={uid} sign_ok={ok}")
                    if not ok:
                        return self._send(401, {"error": {"code": 401, "message": "slop: bad sign"}}, headers=rev)
                    if path == "/api2/v2/users/me":
                        return self._send(200, {"id": int(uid), "username": f"slop{uid}", "name": f"Slop {uid}",
                                                "avatar": None, "isAuth": True,
                                                "wsUrl": f"ws://127.0.0.1:{world.ws_port}/ws3/1",
                                                "wsAuthToken": f"slop-ws-{uid}"}, headers=rev)
                    return self._send(200, {"list": [], "hasMore": False, "items": []}, headers=rev)
                self._send(404, {"error": "not found"})

        return H
