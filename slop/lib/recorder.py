"""A recorded HTTP client for simulated dashboard users. Every call through it lands in the shared Recorder
(method, path, status, latency, body), which the stock checks (no 5xx, nothing leaked) read."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import httpx


class Recorder:
    def __init__(self, path: Path):
        self.path = path
        self.calls: list[dict] = []
        self._lock = threading.Lock()

    def add(self, rec: dict) -> None:
        with self._lock:
            self.calls.append(rec)
            with open(self.path, "a") as f:
                f.write(json.dumps(rec) + "\n")


class User:
    """One dashboard user: signs up through the real better-auth endpoint and then sends the dashboard's
    headers (session cookie, Origin = APP_URL, x-dashboard: 1) on every call."""

    def __init__(self, api_url: str, app_url: str, rec: Recorder, who: str):
        self.rec, self.who, self.app_url = rec, who, app_url
        self.http = httpx.AsyncClient(base_url=api_url, timeout=60,
                                      headers={"origin": app_url, "x-dashboard": "1"})
        self.team_id: str | None = None
        self.cookies: list[dict] = []

    async def call(self, method: str, path: str, **kw) -> httpx.Response:
        t = time.monotonic()
        r = await self.http.request(method, path, **kw)
        self.rec.add({"t": time.time(), "who": self.who, "method": method, "path": path, "status": r.status_code,
                      "ms": round((time.monotonic() - t) * 1000, 1), "body": r.text[:4000]})
        return r

    async def get(self, path: str, **kw) -> httpx.Response:
        return await self.call("GET", path, **kw)

    async def post(self, path: str, **kw) -> httpx.Response:
        return await self.call("POST", path, **kw)

    async def sign_up(self, email: str, password: str) -> None:
        r = await self.post("/api/auth/sign-up/email", json={"email": email, "password": password,
                                                             "name": email.split("@")[0]})
        if r.status_code != 200:
            raise RuntimeError(f"sign-up {email}: {r.status_code} {r.text[:300]}")
        s = (await self.get("/api/auth/get-session")).json()
        self.team_id = s["session"]["activeOrganizationId"]
        self.cookies = [{"name": c.name, "value": c.value} for c in self.http.cookies.jar]

    async def aclose(self) -> None:
        await self.http.aclose()


class KeyClient:
    """One API integration: sends its workspace key as `Authorization: Bearer` on every /v1 call, recorded like
    `User`. A transport failure is recorded as status 0 (never silently dropped)."""

    def __init__(self, api_url: str, rec: Recorder, who: str, secret: str, http: httpx.AsyncClient | None = None):
        self.rec, self.who = rec, who
        self.headers = {"authorization": f"Bearer {secret}"}
        self.http = http or httpx.AsyncClient(base_url=api_url, timeout=60)

    async def call(self, method: str, path: str, **kw) -> httpx.Response | None:
        t = time.monotonic()
        try:
            r = await self.http.request(method, path, headers=self.headers, **kw)
        except httpx.HTTPError as e:
            self.rec.add({"t": time.time(), "who": self.who, "method": method, "path": path, "status": 0,
                          "ms": round((time.monotonic() - t) * 1000, 1), "body": f"{type(e).__name__}: {e}"[:400]})
            return None
        self.rec.add({"t": time.time(), "who": self.who, "method": method, "path": path, "status": r.status_code,
                      "ms": round((time.monotonic() - t) * 1000, 1), "body": r.text[:4000]})
        return r

    async def get(self, path: str, **kw) -> httpx.Response | None:
        return await self.call("GET", path, **kw)

    async def post(self, path: str, **kw) -> httpx.Response | None:
        return await self.call("POST", path, **kw)
