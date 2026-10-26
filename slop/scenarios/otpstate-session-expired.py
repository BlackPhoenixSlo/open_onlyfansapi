"""Flow: OnlyFans starts asking connected accounts for a 2FA code (400 code 101 "otpState") -> the gateway marks them
session_expired, tells each workspace once (webhook accounts.session_expired), stops hammering OF, and shows
"Session expired · re-connect" on the Accounts page, while every other account keeps working.

Real path: OF (lib/fake_world.py) -> the upstream's per-account socket pumps, pollers and /of/* routes -> its /ws ->
the TS API's event ingest, ledger and webhook worker -> the fake receiver (lib/webhook_receiver.py); 42 API
integrations (one key each) on /v1 at once; the owner of workspace 0 in the web app (Vite) in a real browser.

Seeded before any service starts (lib/seed.py): 6 workspaces (owner, credential, member, link), 48 OF accounts (8 per
workspace, account_workspace), 48 API keys (1 write + 7 read per workspace), 19,200 ledger events, 14,400
message_fact rows, 18,000 request_log rows; and the upstream's session store for the 48 accounts. Per workspace:
  account 1  otp-ws    at the trigger OF answers every call 101 and drops its socket (the pump's /users/me sees it)
  account 2  otp-http  at the trigger OF answers every call 101 but keeps its socket (only /v1 calls see it)
  account 3  step-up   OF answers 400 code 105 (a per-request step-up, not a dead session) on /payouts/balances only
  4 to 8     healthy
Declared knobs (in metrics.json `knobs`): the upstream's socket reconnect cap is 2 s (of_ws.RECONNECT_MAX_S, 30 s in
the product), so a reconnect loop shows in a 24 s window; the pollers' interval is 3600 s, so they poll once at pump
start and never after the trigger (the HTTP path alone flags an otp-http account; poll_loop's own on_expired is
covered by its unit tests); the API runs with ALLOW_HTTP_WEBHOOKS=true for the loopback receiver.

Checks:
  webhooks-registered                    each workspace registered the receiver through POST /v1/webhooks (201)
  otpstate-accounts-session-expired      (1) every otp account: exactly one accounts.session_expired ledger row
                                         (event), a webhook_delivery row for its workspace, session_expired in
                                         GET /v1/accounts and in the upstream's GET /of-accounts; no other account
  one-session-expired-webhook-per-account  (2) the receiver got exactly one accounts.session_expired per otp account,
                                         on its own workspace's URL, validly signed; none for any other account
  ws-stops-reconnecting                  (3) /users/me per otp-ws account from the trigger on: at most 2, and none in
                                         the last two thirds of the window and the settle time after it
  http-of-route-flags-account            (4) every /v1/<otp account>/chats after the trigger answered OF's 400 as
                                         of_error (status 400); each otp-http account is flagged within 5 s of its
                                         first one, with no /users/me after the trigger (its socket never noticed)
  healthy-requests-answered-in-order     (5) every /v1 call for the 36 other accounts answered 200 (step-up: 200,
                                         and 400 of_error on /payouts/balances alone); each chat list in OF's order
  healthy-socket-events-relayed-in-order (5) every frame OF pushed on the 36 sockets reached /v1/ws in order, once;
                                         ledger rows and webhook deliveries (each once, signed) match the count
  healthy-and-step-up-stay-active        (5) the 36 stay active in /of-accounts and GET /v1/accounts
  seeded-history-served                  (5) GET /v1/stats per workspace counts exactly the ledger rows SQL counts
  ui-expired-row-menu-reachable          at 1280 px every settled row's "Actions for …" menu button is on screen and
                                         on top (an expired row's wide badge used to push it out of view), and on
                                         each expired row it opens with Edit (screenshot c-expired-row-menu.png)
  ui-session-expired-badge               the trigger and settled screenshots; the settled page shows the badge on
                                         exactly workspace 0's two otp accounts (DB event rows and the API agree)
  no-5xx                                 (6) no 5xx in any recorded call, dashboard response, request_log row of
                                         the run, or the upstream's access log
  nothing-off-host                       the guard refused no connection
  p95-vs-last-green                      (7) end-to-end p95 of the /v1 integrations' and the dashboard's calls within
                                         2x (+250 ms) of the last green run of this scenario (the first sets it)

FAULTS: otpstate-not-refused (master's classifier: a 400 code 101 is an ordinary 400). Expected red: the otpState
checks (otpstate-accounts-session-expired, one-session-expired-webhook-per-account, ws-stops-reconnecting,
http-of-route-flags-account) and the two UI checks on that outcome (ui-session-expired-badge, and
ui-expired-row-menu-reachable, which needs an expired row). The rest stay green.
"""
from __future__ import annotations

import asyncio
import json
import random
import re
import secrets
import string
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

LIB = Path(__file__).resolve().parents[1] / "lib"
sys.path.insert(0, str(LIB))
from fake_world import World
from recorder import KeyClient, Recorder
from report import check_p95
from seed import better_auth_hash, mass_sql, workspaces_sql, write_upstream_session
from stack import UPSTREAM_TOKEN, Stack
from webhook_receiver import Receiver

# A row's "Actions for …" button: inside the viewport and the topmost element at its own centre (not scrolled out of
# the table's overflow box, not covered by the cells scrolling under it).
_ON_SCREEN_JS = """el => {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return {left: Math.round(r.left), right: Math.round(r.right), viewport: window.innerWidth,
          on_screen: r.width > 0 && r.left >= 0 && r.right <= window.innerWidth && !!hit && el.contains(hit)};
}"""

FAULTS = {"otpstate-not-refused": "master's classifier: OF's 400 code 101 (otpState) is an ordinary 400"}

N_WS, PER_WS, READ_KEYS = 6, 8, 7
FRAMES = 5                    # socket frames OF pushes per non-affected account
WINDOW_S = 24                 # observation window from the trigger
SETTLE_S = 45                 # longest wait for webhooks after the window
KNOBS = {"SLOP_WS_RECONNECT_MAX_S": "2", "SENT_POLL_INTERVAL_S": "3600", "MASS_POLL_INTERVAL_S": "3600"}
API_KNOBS = {"ALLOW_HTTP_WEBHOOKS": "true"}
SEED = {"events_per_account": 400, "messages_per_account": 300, "logs_per_workspace": 3000}
STEP_UP_PATH = "/api2/v2/payouts/balances"
BADGE = "Session expired · re-connect"
EXPIRED = "accounts.session_expired"


def _b62(n: int) -> str:
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(n))


def plan() -> list[dict]:
    ws = []
    for w in range(N_WS):
        accts = [880000000 + w * 100 + i for i in range(1, PER_WS + 1)]
        role = {accts[0]: "otp-ws", accts[1]: "otp-http", accts[2]: "step-up"}
        owner = {"id": f"slop-owner-{w}", "email": f"owner{w}@slop.test", "name": f"Owner {w}",
                 "password": f"slop-owner-pass-{w}"}
        keys = [{"id": f"key_slopw{w}write", "name": "slop write", "secret": f"gk_{_b62(32)}", "scope": "write"}]
        keys += [{"id": f"key_slopw{w}read{k}", "name": f"slop client {k}", "secret": f"gk_{_b62(32)}",
                  "scope": "read"} for k in range(READ_KEYS)]
        ws.append({"w": w, "team_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"slop-otpstate-ws-{w}")),
                   "slug": f"slop-ws-{w}", "name": f"Slop workspace {w}", "owner": owner, "accounts": accts,
                   "role": {a: role.get(a, "healthy") for a in accts}, "keys": keys})
    return ws


def by_role(ws: list[dict], *roles: str) -> list[int]:
    return [a for w in ws for a in w["accounts"] if w["role"][a] in roles]


async def run(ctx, out: Path, fault: str | None) -> None:
    from playwright.async_api import async_playwright

    ws = plan()
    owner_of = {a: w for w in ws for a in w["accounts"]}
    uids = {f"of{a}@slop.test": str(a) for a in owner_of}
    rec = Recorder(out / "api-calls.jsonl")
    ctx.metric("knobs", {**KNOBS, **API_KNOBS})
    ctx.metric("seed", {"workspaces": N_WS, "accounts": len(owner_of), "api_keys": N_WS * (1 + READ_KEYS),
                        "events": len(owner_of) * SEED["events_per_account"],
                        "message_facts": len(owner_of) * SEED["messages_per_account"],
                        "request_logs": N_WS * SEED["logs_per_workspace"]})

    async with async_playwright() as pw:
        with World(out, accounts=uids, chromium=pw.chromium.executable_path) as world, Receiver(out) as rx:
            for a in by_role(ws, "step-up"):
                world.step_up[str(a)] = {STEP_UP_PATH}

            def seed(stack: Stack, state: Path) -> None:
                t = time.monotonic()
                for w in ws:
                    w["owner"]["password_hash"] = better_auth_hash(w["owner"]["password"])
                stack.sql_script(workspaces_sql(ws))
                stack.sql_script(mass_sql(ws, **SEED))
                for a in owner_of:
                    write_upstream_session(state, str(a), rules=world.rules, chunk=world.chunk, rev=world.rev,
                                           username=f"slop{a}", name=f"Slop {a}", nickname=f"Creator {a}")
                ctx.metric("seed_s", round(time.monotonic() - t, 2))

            with Stack(out, world, fault=fault, seed=seed, upstream_env=KNOBS, api_env=API_KNOBS) as stack:
                browser = await pw.chromium.launch()
                try:
                    await _flow(ctx, out, ws, owner_of, world, rx, stack, browser, rec)
                finally:
                    await browser.close()
            _after(ctx, out, rec)


async def _upstream_accounts(stack) -> dict[int, str]:
    async with httpx.AsyncClient(timeout=30) as h:
        r = await h.get(f"{stack.up_url}/of-accounts", headers={"authorization": f"Bearer {UPSTREAM_TOKEN}"})
        return {row["id"]: row["status"] for row in r.json()}


async def _wait(pred, timeout: float, step: float = 0.5) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if await pred():
            return True
        await asyncio.sleep(step)
    return await pred()


async def _listen(api_url: str, secret: str, frames: list, ready: asyncio.Event, stop: asyncio.Event) -> None:
    """One /v1/ws client socket for a workspace (its write key): every frame, in arrival order."""
    from websockets.asyncio.client import connect

    url = api_url.replace("http://", "ws://") + "/v1/ws"
    async with connect(url, subprotocols=["bearer", f"bearer.{secret}"], max_size=None) as sock:
        while not stop.is_set():
            try:
                raw = await asyncio.wait_for(sock.recv(), 0.5)
            except TimeoutError:
                continue
            msg = json.loads(raw)
            if msg.get("type") == "ready":
                ready.set()
                continue
            frames.append({"t": time.time(), **msg})


async def _flow(ctx, out, ws, owner_of, world, rx, stack, browser, rec) -> None:
    api, app = stack.api_url, stack.app_url
    all_ids = sorted(owner_of)
    otp_ws, otp_http = by_role(ws, "otp-ws"), by_role(ws, "otp-http")
    otp = otp_ws + otp_http
    others = by_role(ws, "healthy", "step-up")

    # ── every pump connected, and the API's event socket open, before anything is triggered ──
    async def all_active():
        st = await _upstream_accounts(stack)
        return len(st) == len(all_ids) and all(v == "active" for v in st.values())

    if not await _wait(all_active, 90):
        raise RuntimeError(f"not every seeded account went active: {await _upstream_accounts(stack)}")

    async def api_socket():
        return "upstream event socket connected" in (out / "api.log").read_text(errors="replace")

    if not await _wait(api_socket, 30):
        raise RuntimeError("the API never connected its upstream event socket")

    writers = {w["w"]: KeyClient(api, rec, f"ws{w['w']}-write", w["keys"][0]["secret"]) for w in ws}
    secrets_by_tag: dict[str, str] = {}
    reg = []
    for w in ws:
        tag = f"ws{w['w']}"
        r = await writers[w["w"]].post("/v1/webhooks", json={"url": rx.url(tag), "description": "slop receiver"})
        body = r.json() if r is not None and r.status_code == 201 else {}
        secrets_by_tag[tag] = (body.get("endpoint") or {}).get("secret")
        reg.append({"ws": tag, "status": getattr(r, "status_code", 0)})
    ctx.check("webhooks-registered", all(x["status"] == 201 for x in reg) and all(secrets_by_tag.values()),
              registered=reg)

    # ── one /v1/ws client per workspace ──
    stop = asyncio.Event()
    frames = {w["w"]: [] for w in ws}
    readies = {w["w"]: asyncio.Event() for w in ws}
    listeners = [asyncio.create_task(_listen(api, w["keys"][0]["secret"], frames[w["w"]], readies[w["w"]], stop))
                 for w in ws]
    await asyncio.wait_for(asyncio.gather(*(e.wait() for e in readies.values())), 20)

    # ── the owner of workspace 0 signs in; the Accounts page before the trigger ──
    shots = out / "screenshots"
    bctx = await browser.new_context(viewport={"width": 1280, "height": 1000})
    page = await bctx.new_page()
    seen: list[dict] = []

    async def on_response(resp):
        if "/api/" not in resp.url and "/v1/" not in resp.url:
            return
        try:
            body = (await resp.text())[:2000]
        except Exception:  # noqa: BLE001 — a streamed or aborted response
            body = ""
        end = resp.request.timing.get("responseEnd", -1)
        seen.append({"t": time.time(), "method": resp.request.method, "url": resp.url.replace(app, ""),
                     "status": resp.status, "ms": round(end, 1) if end and end > 0 else None, "body": body})

    page.on("response", lambda r: asyncio.ensure_future(on_response(r)))
    w0 = ws[0]
    await page.goto(f"{app}/login")
    await page.locator("#login").fill(w0["owner"]["email"])
    await page.locator("#password").fill(w0["owner"]["password"])
    await page.get_by_role("button", name="Sign in").click()
    await page.wait_for_url(re.compile(r".*/dashboard"), timeout=30_000)
    await page.goto(f"{app}/accounts")
    rows = page.locator("tbody tr")
    await page.get_by_text(str(w0["accounts"][-1]), exact=True).wait_for(timeout=30_000)
    before_badges = [await rows.nth(i).locator("td").nth(5).inner_text() for i in range(await rows.count())]
    await page.screenshot(path=str(shots / "a-trigger-accounts-before-otpstate.png"), full_page=True)

    # ── the trigger: OF wants a 2FA code for the otp accounts and drops the otp-ws sockets ──
    t0 = time.time()
    ctx.metric("trigger_at", t0)
    world.require_otp([str(a) for a in otp])
    for a in otp_ws:
        world.ws_drop(str(a))

    pushed: dict[int, list[int]] = {a: [] for a in others}

    async def pusher():
        for seq in range(1, FRAMES + 1):
            now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "+00:00"
            for a in others:
                mid = a * 1000 + seq
                world.ws_push(str(a), {"api2_chat_message": {
                    "id": mid, "text": f"live {seq}", "fromUser": {"id": 700000000 + seq}, "createdAt": now,
                    "isFromQueue": False, "price": 0, "media": [], "isTip": False, "isOpened": False}})
                pushed[a].append(mid)
            await asyncio.sleep(1.5)

    async def client(w: dict, k: int):
        kc = KeyClient(api, rec, f"ws{w['w']}-c{k}", w["keys"][1 + k]["secret"])
        mine = [a for a in w["accounts"] if w["role"][a] in ("healthy", "step-up")]
        theirs_otp = [a for a in w["accounts"] if w["role"][a].startswith("otp")]
        rnd = random.Random(w["w"] * 100 + k)
        await asyncio.sleep(rnd.random() * 0.5)
        n = 0
        try:
            while time.time() < t0 + WINDOW_S:
                a = mine[(k + n) % len(mine)]
                calls = [kc.get("/v1/accounts"), kc.get(f"/v1/{a}/chats"), kc.get(f"/v1/{a}/payouts/balances"),
                         kc.get(f"/v1/{theirs_otp[(k + n) % 2]}/chats")]
                if n % 3 == k % 3:
                    calls.append(kc.get("/v1/stats"))
                await asyncio.gather(*calls)
                n += 1
                await asyncio.sleep(2.5 + rnd.random())
        finally:
            await kc.http.aclose()

    third = {}

    async def sampler():
        await asyncio.sleep(WINDOW_S / 3)
        third.update({a: len(world.users_me(str(a))) for a in otp_ws})

    t_load = time.monotonic()
    await asyncio.gather(pusher(), sampler(), *(client(w, k) for w in ws for k in range(READ_KEYS)))
    ctx.metric("load_s", round(time.monotonic() - t_load, 1))
    ctx.metric("clients", N_WS * READ_KEYS)

    # ── settle: webhooks delivered (or the settle time is up) ──
    want_msgs = len(others) * FRAMES

    async def delivered():
        return len(rx.of_type(EXPIRED)) >= len(otp) and len(rx.of_type("messages.received")) >= want_msgs

    await _wait(delivered, SETTLE_S, 1.0)
    t_end = time.time()
    ctx.metric("settled_after_trigger_s", round(t_end - t0, 1))
    await asyncio.sleep(1.5)  # a late duplicate would land here

    # ── the settled Accounts page ──
    shown = 0
    t_ui = time.monotonic()
    while time.monotonic() - t_ui < 20:
        await page.reload()
        await page.get_by_text(str(w0["accounts"][-1]), exact=True).wait_for(timeout=30_000)
        shown = await page.get_by_text(BADGE).count()
        if shown >= 2:
            break
        await asyncio.sleep(2)
    await page.screenshot(path=str(shots / "b-settled-session-expired.png"), full_page=True)
    badge_rows = []
    for i in range(await rows.count()):
        cells = rows.nth(i).locator("td")
        badge_rows.append({"id": int((await cells.nth(4).inner_text()).strip()),
                           "status": (await cells.nth(5).inner_text()).strip()})
    # Each row's menu (Edit, Disconnect) must be on screen at 1280 px, not pushed out by a wide expired row.
    row_menus = []
    for i in range(await rows.count()):
        button = rows.nth(i).get_by_role("button", name=re.compile(r"^Actions for "))
        row_menus.append({"id": badge_rows[i]["id"], **await button.evaluate(_ON_SCREEN_JS)})
    menu_opened = []
    for i, r in enumerate(badge_rows):
        if r["status"] != BADGE:
            continue
        button = rows.nth(i).get_by_role("button", name=re.compile(r"^Actions for "))
        menu = page.get_by_role("menu", name=await button.get_attribute("aria-label"))
        await button.click()
        edit = menu.get_by_role("menuitem", name="Edit")
        opened = await _wait(edit.is_visible, 3, 0.2)
        if opened and not menu_opened:
            await page.screenshot(path=str(shots / "c-expired-row-menu.png"))
        menu_opened.append({"id": r["id"], "edit_shown": bool(opened)})
        await page.keyboard.press("Escape")
        await menu.wait_for(state="hidden", timeout=5_000)
    stop.set()
    await asyncio.gather(*listeners, return_exceptions=True)

    # ── what everything says now ──
    up = await _upstream_accounts(stack)
    api_status: dict[int, str] = {}
    for w in ws:
        r = await writers[w["w"]].get("/v1/accounts")
        for item in (r.json().get("items", []) if r is not None and r.status_code == 200 else []):
            api_status[item["id"]] = item["status"]
    stats_ok = []
    today = datetime.now(UTC).date()
    frm = (today - timedelta(days=29)).isoformat()
    for w in ws:
        r = await writers[w["w"]].get(f"/v1/stats?from={frm}&to={today.isoformat()}")
        got = sum(row["count"] for row in r.json()["rows"]) if r is not None and r.status_code == 200 else None
        ids = ",".join(map(str, w["accounts"]))
        [[want]] = stack.sql(f"select count(*) from event where account_id in ({ids}) and created_at >= '{frm}' "
                             f"and created_at < '{(today + timedelta(days=1)).isoformat()}'")
        stats_ok.append({"ws": w["w"], "api": got, "sql": int(want)})
    for c in writers.values():
        await c.http.aclose()

    ev_rows = stack.sql(f"select account_id, count(*) from event where type = '{EXPIRED}' group by account_id")
    ev = {int(a): int(n) for a, n in ev_rows}
    dl_rows = stack.sql(f"select account_id, team_id, status from webhook_delivery where event_type = '{EXPIRED}'")
    live_rows = stack.sql("select account_id, count(*) from event where dedup_key like 'message.received:%' "
                          "group by account_id")
    live = {int(a): int(n) for a, n in live_rows}
    since = datetime.fromtimestamp(t0 - 120, UTC).isoformat()
    log_5xx = stack.sql(f"select path, status_code from request_log where status_code >= 500 and created_at > '{since}'")
    run_logs = stack.sql(f"select count(*) from request_log where created_at > '{since}'")

    (out / "dashboard-responses.jsonl").write_text("".join(json.dumps(s) + "\n" for s in seen))
    (out / "ws-client-frames.jsonl").write_text(
        "".join(json.dumps({"ws": k, **f}) + "\n" for k, fs in frames.items() for f in fs))
    (out / "fake-of-api-calls.jsonl").write_text("".join(json.dumps(c) + "\n" for c in world.api_calls))
    await bctx.close()

    # ── (1) every otp account reached session_expired, in the DB, the API and the upstream ──
    team = {a: w["team_id"] for a, w in owner_of.items()}
    dl_by = {}
    for a, t, s in dl_rows:
        dl_by.setdefault(int(a), []).append((t, s))
    per = [{"id": a, "event_rows": ev.get(a, 0), "deliveries": dl_by.get(a, []), "api": api_status.get(a),
            "upstream": up.get(a)} for a in otp]
    ok1 = all(p["event_rows"] == 1 and len(p["deliveries"]) == 1 and p["deliveries"][0][0] == team[p["id"]]
              and p["api"] == "session_expired" and p["upstream"] == "session_expired" for p in per)
    stray = sorted(set(ev) - set(otp))
    ctx.check("otpstate-accounts-session-expired", ok1 and not stray, otp_accounts=len(otp),
              reached=sum(1 for p in per if p["upstream"] == "session_expired"), stray_event_rows=stray,
              accounts=per)

    # ── (2) one webhook per otp account, to its own workspace, none for the others ──
    hooks = rx.of_type(EXPIRED)
    tag_of = {a: f"ws{w['w']}" for a, w in owner_of.items()}
    got = {}
    for h in hooks:
        got.setdefault(int(h["account_id"]), []).append(h)
    bad = [{"id": a, "n": len(got.get(a, [])), "tags": [h["tag"] for h in got.get(a, [])]} for a in otp
           if len(got.get(a, [])) != 1 or got[a][0]["tag"] != tag_of[a]
           or not rx.verified(got[a][0], secrets_by_tag[tag_of[a]])]
    for_others = sorted(set(got) - set(otp))
    ctx.check("one-session-expired-webhook-per-account", not bad and not for_others and len(hooks) == len(otp),
              deliveries=len(hooks), expected=len(otp), wrong=bad, for_other_accounts=for_others)

    # ── (3) the socket stops asking /users/me ──
    counts = []
    for a in otp_ws:
        calls = world.users_me(str(a))
        after = [round(t - t0, 1) for t in calls if t >= t0]
        late = [t for t in after if t >= WINDOW_S / 3]
        counts.append({"id": a, "before_trigger": len(calls) - len(after), "after_trigger": len(after),
                       "at_third_of_window": third.get(a, 0) - (len(calls) - len(after)), "late": len(late),
                       "after_s": after[:30]})
    ctx.metric("users_me_per_otp_ws_account", counts)
    ctx.check("ws-stops-reconnecting", all(c["after_trigger"] <= 2 and c["late"] == 0 for c in counts),
              window_s=WINDOW_S, settle_s=round(t_end - t0 - WINDOW_S, 1), reconnect_max_s=KNOBS[
                  "SLOP_WS_RECONNECT_MAX_S"], accounts=counts)

    # ── (4) /v1 -> /of/* for an otp account: OF's 400 as of_error, and the account flagged ──
    calls = rec.calls
    otp_calls = [c for c in calls if c["t"] >= t0 and re.fullmatch(rf"/v1/({'|'.join(map(str, otp))})/chats", c["path"])]

    def of_error_400(c):
        try:
            e = json.loads(c["body"]).get("error", {})
        except ValueError:
            return False
        return c["status"] == 400 and e.get("code") == "of_error" and e.get("status") == 400

    wrong = [{"path": c["path"], "status": c["status"], "body": c["body"][:200]} for c in otp_calls
             if not of_error_400(c)]
    http_flag = []
    for a in otp_http:
        first = min((c["t"] for c in otp_calls if c["path"] == f"/v1/{a}/chats"), default=None)
        hk = got.get(a, [])
        http_flag.append({"id": a, "first_call_s": round(first - t0, 2) if first else None,
                          "webhook_after_first_call_s": round(hk[0]["t"] - first, 2) if hk and first else None,
                          "upstream": up.get(a), "users_me_after_trigger": sum(1 for t in world.users_me(str(a))
                                                                               if t >= t0)})
    ok4 = bool(otp_calls) and not wrong and all(
        f["upstream"] == "session_expired" and f["first_call_s"] is not None and f["users_me_after_trigger"] == 0
        and f["webhook_after_first_call_s"] is not None and f["webhook_after_first_call_s"] < 5 for f in http_flag)
    ctx.check("http-of-route-flags-account", ok4, otp_calls=len(otp_calls), not_of_error_400=wrong[:5],
              otp_http=http_flag)

    # ── (5) the other 36 accounts keep working ──
    step_up = set(by_role(ws, "step-up"))
    other_re = re.compile(rf"/v1/({'|'.join(map(str, others))})/(.+)")
    bad5, order_bad, n5 = [], [], 0
    for c in calls:
        m = other_re.fullmatch(c["path"])
        if not m:
            if c["path"] in ("/v1/accounts", "/v1/stats") and c["status"] != 200:
                bad5.append({"path": c["path"], "status": c["status"]})
            continue
        n5 += 1
        a, rest = int(m[1]), m[2]
        if a in step_up and rest == "payouts/balances":
            if not of_error_400(c):
                bad5.append({"path": c["path"], "status": c["status"], "want": "400 of_error"})
            continue
        if c["status"] != 200:
            bad5.append({"path": c["path"], "status": c["status"]})
            continue
        if rest == "chats":
            ids = [x["withUser"]["id"] for x in json.loads(c["body"])["data"]["list"]]
            if ids != [x["withUser"]["id"] for x in world.chat_list(str(a))]:
                order_bad.append({"path": c["path"], "ids": ids})
    ctx.check("healthy-requests-answered-in-order", n5 > 0 and not bad5 and not order_bad, calls=n5,
              not_answered=bad5[:10], out_of_order=order_bad[:5])

    relayed_bad = []
    for a in others:
        w = owner_of[a]["w"]
        ids = [f["payload"]["id"] for f in frames[w] if f.get("event") == "messages.received"
               and f.get("account_id") == str(a)]
        sent = [f["api2_chat_message"]["id"] for f in world.ws_sent.get(str(a), []) if "api2_chat_message" in f]
        hk = [h for h in rx.of_type("messages.received") if h["account_id"] == str(a)]
        keys = {h["key"] for h in hk}
        if not (ids == sent == pushed[a] and live.get(a, 0) == FRAMES and len(hk) == FRAMES == len(keys)
                and all(h["tag"] == tag_of[a] and rx.verified(h, secrets_by_tag[tag_of[a]]) for h in hk)):
            relayed_bad.append({"id": a, "pushed": len(pushed[a]), "of_sent": len(sent), "ws_client": ids,
                                "ledger": live.get(a, 0), "webhooks": len(hk), "unique_keys": len(keys)})
    ctx.check("healthy-socket-events-relayed-in-order", not relayed_bad, accounts=len(others), frames_each=FRAMES,
              pushed=sum(len(v) for v in pushed.values()), wrong=relayed_bad[:5])

    inactive = [{"id": a, "upstream": up.get(a), "api": api_status.get(a)} for a in others
                if up.get(a) != "active" or api_status.get(a) != "active"]
    ctx.check("healthy-and-step-up-stay-active", not inactive, accounts=len(others), step_up=len(step_up),
              not_active=inactive[:10])
    ctx.check("seeded-history-served", all(s["api"] == s["sql"] for s in stats_ok), workspaces=stats_ok)

    # ── the UI: the trigger and the settled state, and their side effects ──
    w0_otp = {a for a in w0["accounts"] if w0["role"][a].startswith("otp")}
    shown_ids = {r["id"] for r in badge_rows if r["status"] == BADGE}
    ctx.check("ui-session-expired-badge",
              all(b.strip() == "active" for b in before_badges) and len(before_badges) == PER_WS
              and shown_ids == w0_otp and all(ev.get(a) == 1 and api_status.get(a) == "session_expired"
                                              for a in w0_otp),
              trigger_screenshot="screenshots/a-trigger-accounts-before-otpstate.png",
              settled_screenshot="screenshots/b-settled-session-expired.png", before=before_badges,
              settled=badge_rows, db_event_rows={a: ev.get(a, 0) for a in w0_otp},
              api_status={a: api_status.get(a) for a in w0_otp})

    off_screen = [m for m in row_menus if not m["on_screen"]]
    ctx.check("ui-expired-row-menu-reachable",
              bool(menu_opened) and not off_screen and len(row_menus) == len(badge_rows)
              and all(m["edit_shown"] for m in menu_opened),
              screenshot="screenshots/c-expired-row-menu.png", viewport_width=1280, rows=len(row_menus),
              off_screen=off_screen, expired_rows_menu=menu_opened)

    ctx.metric("api_calls", len(calls))
    ctx.metric("request_log_rows_in_run", int(run_logs[0][0]))
    ctx.metric("request_log_5xx", log_5xx[:10])
    ctx.metric("dashboard_responses", len(seen))
    (out / "dashboard-ms.json").write_text(json.dumps([s["ms"] for s in seen if s["ms"] is not None]))


def _after(ctx, out: Path, rec) -> None:
    """Checks over the run's records, once every process has stopped and flushed its log."""
    calls = rec.calls
    dash = [json.loads(ln) for ln in (out / "dashboard-responses.jsonl").read_text().splitlines()]
    fivexx = [{"path": c.get("path") or c.get("url"), "status": c["status"]} for c in calls + dash
              if c["status"] >= 500 or c["status"] == 0]
    up_log = (out / "upstream.log").read_text(errors="replace")
    up_5xx = re.findall(r'"[A-Z]+ [^"]*" 5\d\d', up_log)
    ctx.check("no-5xx", not fivexx and not up_5xx and not ctx.metrics.get("request_log_5xx"),
              calls=len(calls) + len(dash), fivexx_or_no_answer=fivexx[:10], upstream_5xx=up_5xx[:5],
              request_log_5xx=ctx.metrics.get("request_log_5xx"))
    refused = (out / "offhost-refused.jsonl").read_text().splitlines()
    ctx.check("nothing-off-host", not refused, refused=refused[:5])
    ms = [c["ms"] for c in calls] + [d["ms"] for d in dash if d.get("ms") is not None]
    check_p95(ctx, out, ms)
