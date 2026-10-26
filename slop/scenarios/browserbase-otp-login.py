"""Flow: Try Browserbase login -> OnlyFans asks for the 2FA code -> the operator types it in the dashboard.

Real path: the web app (Vite) -> the TS API -> the upstream -> a "Browserbase" session (a local Chromium over CDP) ->
"OnlyFans" (lib/fake_world.py). One dashboard user (A) drives the UI in a real browser; a second workspace (B) only
probes the owner check. Nothing is seeded: sign-up links the workspace, and the login creates the account.

Checks (one flow, run once: a login is one operator at a time, not a volume path):
  prompt-shown-next-to-live-view   the code field and the live view iframe are on screen together
  otp-route-400-malformed          malformed codes are 400 at both layers, and the code is never echoed
  otp-route-404-unknown-job        an unknown job is 404
  otp-route-403-other-workspace    another workspace's job is 403
  otp-field-locked-while-checking  after Submit the field is disabled
  otp-route-409-while-checking     a second code while one is being checked is 409
  wrong-code-rejected-stays-otp    the wrong code reaches OF's visible field, OF refuses it, the dialog says
                                   "didn't accept", and the job stays in otp (checking off)
  right-code-logs-in               the right code (typed "739-218") reaches OF's visible field and the login is done:
                                   the dialog closes and the account is listed
  account-row-and-api              account_workspace has the account for A's workspace; GET /v1/accounts lists it
  otp-route-409-after-done         a code after done is 409
  otp-record-counts                OF saw exactly the two codes, in order (nothing dropped, nothing extra)
  stale-hidden-input-untouched     the hidden stale input ahead of the real field was never filled
  code-never-leaked                neither code appears in any log, any status or error body, or the fakes' own log
  no-5xx                           no 5xx on any API call the browser or the probes made
  bb-session-released              every Browserbase session the run opened was released
  nothing-off-host                 the guard refused no connection
  p95-vs-last-green                end-to-end p95 of the dashboard's API calls is within 2x (+250 ms) of the last
                                   green run of this scenario (the first run sets the baseline)

FAULTS: otp-code-never-consumed (the upstream never takes the code from the job's slot). Expected red: the checks that
need the code to reach OF (wrong-code-rejected-stays-otp, right-code-logs-in, account-row-and-api,
otp-route-409-after-done, otp-record-counts). Everything else stays green.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from pathlib import Path

LIB = Path(__file__).resolve().parents[1] / "lib"
sys.path.insert(0, str(LIB))
from fake_world import World
from recorder import Recorder
from report import check_p95
from stack import Stack

FAULTS = {"otp-code-never-consumed": "the worker never takes the code from the job's slot"}

OF_EMAIL = "creator@slop.test"
OF_UID = "990000101"
OF_PASSWORD = "slop-of-password-1"
CODE, WRONG = "739218", "104857"
CODE_TYPED, WRONG_TYPED = "739-218", "104 857"
REJECTED = "didn't accept that code"
LEAK_FORMS = (CODE, WRONG, CODE_TYPED, WRONG_TYPED, "739 218", "104-857")


class Probe:
    """Direct calls to the real API through the web origin (the dashboard's own cookie and CSRF headers), recorded."""

    def __init__(self, req, app_url: str, rec, who: str):
        self.req, self.app_url, self.rec, self.who = req, app_url, rec, who

    async def call(self, method: str, path: str, body=None):
        t = time.monotonic()
        r = await self.req.fetch(f"{self.app_url}{path}", method=method,
                                 headers={"origin": self.app_url, "x-dashboard": "1",
                                          **({"content-type": "application/json"} if body is not None else {})},
                                 data=None if body is None else (body if isinstance(body, str) else json.dumps(body)))
        text = await r.text()
        self.rec.add({"t": time.time(), "who": self.who, "method": method, "path": path, "status": r.status,
                      "ms": round((time.monotonic() - t) * 1000, 1), "body": text[:4000]})
        return r.status, text

    async def sign_up(self, email: str, password: str) -> None:
        st, text = await self.call("POST", "/api/auth/sign-up/email",
                                   {"email": email, "password": password, "name": email.split("@")[0]})
        if st != 200:
            raise RuntimeError(f"sign-up {email}: {st} {text[:300]}")


def err_code(text: str) -> str | None:
    try:
        return json.loads(text).get("error", {}).get("code")
    except (ValueError, AttributeError):
        return None


async def run(ctx, out: Path, fault: str | None) -> None:
    from playwright.async_api import async_playwright

    rec = Recorder(out / "api-calls.jsonl")
    shots = out / "screenshots"

    async with async_playwright() as pw:
        chromium = pw.chromium.executable_path
        with World(out, accounts={OF_EMAIL: OF_UID}, otp=CODE, password=OF_PASSWORD, chromium=chromium) as world, \
                Stack(out, world, fault=fault) as stack:
            browser = await pw.chromium.launch()
            try:
                await _flow(ctx, out, fault, world, stack, browser, rec, shots)
            finally:
                await browser.close()
        _after(ctx, out, world, rec)


async def _flow(ctx, out, fault, world, stack, browser, rec, shots) -> None:
    app = stack.app_url
    ctx_a = await browser.new_context(viewport={"width": 1280, "height": 1000})
    ctx_b = await browser.new_context()
    a = Probe(ctx_a.request, app, rec, "A")
    b = Probe(ctx_b.request, app, rec, "B")
    await a.sign_up("owner-a@slop.test", "slop-dashboard-pass-A1")
    await b.sign_up("owner-b@slop.test", "slop-dashboard-pass-B1")

    page = await ctx_a.new_page()
    seen: list[dict] = []  # every /api and /v1 response the dashboard itself got

    async def on_response(resp):
        url = resp.url
        if "/api/" not in url and "/v1/" not in url:
            return
        try:
            body = (await resp.text())[:4000]
        except Exception:  # noqa: BLE001 — a streamed or aborted response
            body = ""
        timing = resp.request.timing
        ms = timing.get("responseEnd", -1)
        seen.append({"t": time.time(), "method": resp.request.method, "url": url.replace(app, ""), "status": resp.status,
                     "ms": round(ms, 1) if ms and ms > 0 else None, "body": body})

    page.on("response", lambda r: asyncio.ensure_future(on_response(r)))

    await page.goto(f"{app}/accounts")
    await page.get_by_role("button", name="Try Browserbase login").first.click()
    await page.locator("#bl-email").fill(OF_EMAIL)
    await page.locator("#bl-password").fill(OF_PASSWORD)
    async with page.expect_response(lambda r: r.url.endswith("/api/accounts/login/browser/start")) as started:
        await page.get_by_role("dialog").get_by_role("button", name="Try Browserbase login").click()
    job_id = json.loads(await (await started.value).text())["jobId"]
    ctx.metric("job_id", job_id)

    # ── the prompt, next to the live view ──
    otp = page.locator("#bl-otp")
    live = page.locator("iframe[title='Browserbase live view']")
    shown = True
    try:
        await otp.wait_for(state="visible", timeout=60_000)
        await live.wait_for(state="visible", timeout=5_000)
        await page.wait_for_timeout(2_500)  # the live view's next frame shows OF's 2FA page
    except Exception as e:  # noqa: BLE001
        shown = False
        ctx.metric("prompt_wait_error", type(e).__name__)
    await page.screenshot(path=str(shots / "a-otp-prompt-next-to-live-view.png"))
    ctx.check("prompt-shown-next-to-live-view", shown and await otp.is_visible() and await live.is_visible(),
              screenshot="screenshots/a-otp-prompt-next-to-live-view.png")
    if not shown:
        raise RuntimeError("the 2FA prompt never showed; nothing below can run")

    otp_path = f"/api/accounts/login/browser/{job_id}/otp"
    # ── malformed: 400 at both layers, never echoed ──
    cases = [({"code": "12ab56"}, "invalid_otp"), ({"code": "12345"}, "invalid_otp"),
             ({"code": "123456789"}, "invalid_otp"), ({"code": "１２３４５６"}, "invalid_otp"),
             ({"code": "9" * 80}, "validation_error"), ({}, "validation_error"), ({"code": 739218}, "validation_error")]
    got = []
    for body, want in cases:
        st, text = await a.call("POST", otp_path, body)
        raw = str(body.get("code", ""))
        got.append({"sent_len": len(raw), "status": st, "code": err_code(text), "want": want,
                    "echoed": bool(raw) and raw in text})
    ctx.check("otp-route-400-malformed", all(g["status"] == 400 and g["code"] == g["want"] and not g["echoed"]
                                             for g in got), cases=got)
    st, text = await a.call("POST", "/api/accounts/login/browser/00000000deadbeef/otp", {"code": CODE})
    ctx.check("otp-route-404-unknown-job", st == 404 and err_code(text) == "job_not_found", status=st,
              code=err_code(text))
    st, text = await b.call("POST", otp_path, {"code": CODE})
    ctx.check("otp-route-403-other-workspace", st == 403 and err_code(text) == "job_forbidden" and CODE not in text,
              status=st, code=err_code(text))

    # ── the wrong code, through the UI ──
    await otp.fill(WRONG_TYPED)
    submit = page.get_by_role("button", name="Submit code")
    t0 = time.monotonic()
    await submit.click()
    locked = False
    try:
        await page.wait_for_function("() => document.getElementById('bl-otp')?.disabled === true", timeout=5_000)
        locked = True
    except Exception:  # noqa: BLE001
        pass
    ctx.check("otp-field-locked-while-checking", locked)
    st, text = await a.call("POST", otp_path, {"code": CODE})
    ctx.check("otp-route-409-while-checking", st == 409 and err_code(text) == "otp_not_expected" and CODE not in text,
              status=st, code=err_code(text))

    rejected = False
    try:
        await page.get_by_role("alert").filter(has_text=REJECTED).wait_for(timeout=45_000)
        rejected = True
    except Exception:  # noqa: BLE001
        pass
    ctx.metric("wrong_code_to_rejected_s", round(time.monotonic() - t0, 1))
    st, text = await a.call("GET", f"/api/accounts/login/browser/{job_id}")
    snap = json.loads(text) if st == 200 else {}
    first = world.otp_record[:1]
    reached = bool(first) and first[0]["code"] == WRONG and not first[0]["ok"]
    if rejected:
        await page.screenshot(path=str(shots / "wrong-code-rejected.png"))
    ctx.check("wrong-code-rejected-stays-otp",
              rejected and reached and snap.get("state") == "otp" and snap.get("otpChecking") is False
              and REJECTED in (snap.get("otpError") or ""),
              dialog_said_rejected=rejected, of_got_wrong_code_in_visible_field=reached, state=snap.get("state"),
              otpChecking=snap.get("otpChecking"))

    # ── the right code, through the UI ──
    done = False
    t1 = time.monotonic()
    try:
        await otp.fill(CODE_TYPED, timeout=5_000)
        await submit.click(timeout=5_000)
        await page.get_by_role("dialog").wait_for(state="detached", timeout=60_000)
        await page.get_by_text(f"slop{OF_UID}").first.wait_for(timeout=20_000)
        done = True
    except Exception as e:  # noqa: BLE001
        ctx.metric("right_code_error", f"{type(e).__name__}: {str(e).splitlines()[0][:200]}")
    ctx.metric("right_code_to_listed_s", round(time.monotonic() - t1, 1))
    await page.wait_for_timeout(500)
    await page.screenshot(path=str(shots / "b-settled-logged-in.png"))
    good = [r for r in world.otp_record if r["code"] == CODE and r["ok"]]
    ctx.check("right-code-logs-in", done and bool(good), dialog_closed_and_listed=done, of_accepted_code=bool(good),
              screenshot="screenshots/b-settled-logged-in.png")

    # ── side effects: the DB row and the API ──
    rows = stack.sql(f"select team_id from account_workspace where account_id = {int(OF_UID)}")
    st, text = await a.call("GET", "/api/auth/get-session")
    team_a = (json.loads(text).get("session") or {}).get("activeOrganizationId") if st == 200 else None
    st, text = await a.call("GET", "/v1/accounts")
    items = json.loads(text).get("items", []) if st == 200 else []
    listed = [i for i in items if str(i.get("id")) == OF_UID]
    ctx.check("account-row-and-api", rows == [[team_a]] and bool(listed) and listed[0].get("status") == "active",
              db_rows=rows, team_a=team_a, api_listed=listed)

    st, text = await a.call("POST", otp_path, {"code": CODE})
    ctx.check("otp-route-409-after-done", done and st == 409 and err_code(text) == "otp_not_expected", status=st,
              code=err_code(text))

    if not done:  # leave nothing running: stop the login the way the operator would
        try:
            await page.get_by_role("button", name="Stop login").click(timeout=5_000)
        except Exception:  # noqa: BLE001
            await a.call("POST", f"/api/accounts/login/browser/{job_id}/cancel")
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not all(s.get("released") for s in world.sessions.values()):
        await asyncio.sleep(0.25)

    (out / "dashboard-responses.jsonl").write_text("".join(json.dumps(s) + "\n" for s in seen))
    ctx.metric("dashboard_responses", len(seen))
    ctx.metric("dashboard_ms", [s["ms"] for s in seen if s["ms"] is not None])
    await ctx_a.close()
    await ctx_b.close()


def _after(ctx, out: Path, world: World, rec) -> None:
    """Checks over the run's records, once every process has stopped and flushed its log."""
    codes = [r["code"] for r in world.otp_record]
    ctx.check("otp-record-counts", codes == [WRONG, CODE], submissions=len(codes),
              in_order=codes == [WRONG, CODE])
    ctx.check("stale-hidden-input-untouched", all(r["stale"] == "" for r in world.otp_record),
              submissions=len(world.otp_record))

    # The one place a code may appear is OF's own wire record (fake-of-otp-record.jsonl), and the probes' request
    # bodies, which are not recorded. Everything else the run wrote is searched.
    allowed = {"fake-of-otp-record.jsonl"}
    leaks = []
    for f in sorted(out.rglob("*")):
        if not f.is_file() or f.name in allowed or f.suffix in (".png",) or "fake-world/slopbb" in str(f) \
                or "upstream-state" in f.parts:
            continue
        text = f.read_text(errors="replace")
        for form in LEAK_FORMS:
            if form in text:
                leaks.append({"file": str(f.relative_to(out)), "form_len": len(form)})
    state = out / "upstream-state"
    if state.exists():  # the upstream's own state: searched too, but it is binary-ish (sqlite)
        for f in state.rglob("*"):
            if f.is_file() and any(form.encode() in f.read_bytes() for form in LEAK_FORMS):
                leaks.append({"file": str(f.relative_to(out)), "form_len": None})
    searched = [p.name for p in out.glob("*.log")]
    ctx.check("code-never-leaked", not leaks and {"upstream.log", "api.log", "web.log"} <= set(searched),
              leaks=leaks, logs_searched=sorted(searched))

    calls = [json.loads(ln) for ln in (out / "api-calls.jsonl").read_text().splitlines()]
    dash_file = out / "dashboard-responses.jsonl"
    dash = [json.loads(ln) for ln in dash_file.read_text().splitlines()] if dash_file.exists() else []
    fivexx = [{"path": c.get("path") or c.get("url"), "status": c["status"]} for c in calls + dash if c["status"] >= 500]
    up_log = (out / "upstream.log").read_text(errors="replace") if (out / "upstream.log").exists() else ""
    up_5xx = re.findall(r'" 5\d\d ', up_log)
    ctx.check("no-5xx", not fivexx and not up_5xx, calls=len(calls) + len(dash), fivexx=fivexx[:10],
              upstream_5xx=len(up_5xx))

    opened = list(world.sessions.values())
    ctx.check("bb-session-released", bool(opened) and all(s.get("released") for s in opened), sessions=len(opened),
              released=sum(1 for s in opened if s.get("released")))
    refused = (out / "offhost-refused.jsonl").read_text().splitlines()
    ctx.check("nothing-off-host", not refused, refused=refused[:5])

    ms = [c["ms"] for c in calls if c.get("ms") is not None] + [d["ms"] for d in dash if d.get("ms") is not None]
    check_p95(ctx, out, ms)
