"""The real stack for one slop run, on loopback: a fresh `gateway_slop` database (dropped, created, migrated with the
repo's migrate script), the real upstream (lib/upstream_launcher.py), the real TS API (tsx src/server.ts) and the real
web app (Vite with lib/vite.slop.config.mts). Every process gets its own process group and log file in the run
folder and is killed on exit, also on failure or Ctrl-C. Never touches the `gateway` or `gateway_test` databases."""
from __future__ import annotations

import os
import signal
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIB = Path(__file__).resolve().parent
VENV_PY = os.environ.get("SLOP_PY") or str(Path.home() / ".cache/gateway-upstream-venv/bin/python")
PG = "postgres://gateway:gateway@127.0.0.1:5434"
DB = "gateway_slop"
UPSTREAM_TOKEN = "slop-upstream-token-0123456789abcdef"


def port_free(port: int) -> bool:
    for host in ("127.0.0.1", "::1"):
        fam = socket.AF_INET6 if ":" in host else socket.AF_INET
        s = socket.socket(fam)
        try:
            s.bind((host, port))
        except OSError:
            return False
        finally:
            s.close()
    return True


def pick_port(start: int) -> int:
    for p in range(start, start + 100):
        if port_free(p):
            return p
    raise RuntimeError(f"no free port from {start}")


class Stack:
    """`seed(stack, state_dir)` runs after the migration and before any service starts (SQL into `gateway_slop`, files
    into the upstream's state dir); `upstream_env` / `api_env` add a scenario's declared knobs to those processes."""

    def __init__(self, out: Path, world, *, fault: str | None, seed=None, upstream_env: dict | None = None,
                 api_env: dict | None = None):
        self.out, self.world, self.fault = out, world, fault
        self.seed, self.upstream_env, self.api_env = seed, dict(upstream_env or {}), dict(api_env or {})
        self.procs: list[tuple[str, subprocess.Popen]] = []
        self.guard_log = out / "offhost-refused.jsonl"
        self.guard_log.touch()

    # ── processes ──
    def spawn(self, name: str, cmd: list[str], *, cwd: Path, env: dict) -> subprocess.Popen:
        log = open(self.out / f"{name}.log", "ab")
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.procs.append((name, p))
        return p

    def stop(self) -> None:
        for _name, p in reversed(self.procs):
            if p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        deadline = time.time() + 10
        for _name, p in self.procs:
            try:
                p.wait(timeout=max(0.1, deadline - time.time()))
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    def wait_http(self, name: str, url: str, timeout: float = 90) -> None:
        deadline = time.time() + timeout
        proc = dict(self.procs)[name]
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"{name} exited with {proc.returncode}; see {name}.log")
            try:
                with urllib.request.urlopen(url, timeout=2) as r:
                    if r.status < 500:
                        return
            except urllib.error.HTTPError as e:
                if e.code < 500:
                    return
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.3)
        raise RuntimeError(f"{name} not ready at {url} after {timeout}s")

    # ── bring-up ──
    def db(self) -> None:
        env = {**os.environ, "PGCONNECT_TIMEOUT": "5"}
        for sql in (f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)', f'CREATE DATABASE "{DB}"'):
            subprocess.run(["psql", f"{PG}/postgres", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], check=True, env=env,
                           capture_output=True)
        with open(self.out / "migrate.log", "wb") as log:
            subprocess.run([str(ROOT / "apps/api/node_modules/.bin/tsx"), "src/db/migrate.ts", self.database_url],
                           cwd=ROOT / "apps/api", check=True, stdout=log, stderr=subprocess.STDOUT)

    @property
    def database_url(self) -> str:
        return f"{PG}/{DB}"

    def sql_script(self, script: str) -> None:
        """Run a multi-statement SQL script (seeding) in one psql session; any error stops it."""
        subprocess.run(["psql", self.database_url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], input=script,
                       check=True, capture_output=True, text=True)

    def sql(self, query: str) -> list[list[str]]:
        r = subprocess.run(["psql", self.database_url, "-At", "-F", "\t", "-c", query], check=True,
                           capture_output=True, text=True)
        return [ln.split("\t") for ln in r.stdout.splitlines() if ln]

    def __enter__(self) -> Stack:
        try:
            self._up()
        except BaseException:
            self.stop()
            raise
        return self

    def __exit__(self, *_a) -> None:
        self.stop()

    def _up(self) -> None:
        w = self.world
        self.db()
        self.up_port = pick_port(4310)
        state = self.out / "upstream-state"
        state.mkdir()
        if self.seed is not None:
            self.seed(self, state)
        up_env = {**os.environ, "UPSTREAM_TOKEN": UPSTREAM_TOKEN, "UPSTREAM_STATE_DIR": str(state),
                  "BROWSERBASE_API_KEY": w.bb_key, "BROWSERBASE_PROJECT_ID": w.bb_project,
                  "SLOP_OF_API": w.of_api, "SLOP_BB_API": w.bb_api, "SLOP_GUARD_LOG": str(self.guard_log),
                  "SLOP_FAULT": self.fault or "", "SENT_POLL_INTERVAL_S": "10", "MASS_POLL_INTERVAL_S": "10",
                  "PYTHONUNBUFFERED": "1", **self.upstream_env}
        up_env.pop("STATIC_PARAM", None)
        self.spawn("upstream", [VENV_PY, str(LIB / "upstream_launcher.py"), str(self.up_port)],
                   cwd=ROOT / "services/upstream", env=up_env)
        self.wait_http("upstream", f"http://127.0.0.1:{self.up_port}/healthz", 60)

        self.api_port = pick_port(4100)
        self.web_port = pick_port(5180)
        self.app_url = f"http://localhost:{self.web_port}"
        self.api_url = f"http://127.0.0.1:{self.api_port}"
        self.up_url = f"http://127.0.0.1:{self.up_port}"
        node_opts = f"--require {LIB / 'node_guard.cjs'}"
        clean = {k: v for k, v in os.environ.items() if not k.startswith(("DATABASE_URL", "UPSTREAM_", "APP_URL",
                                                                            "BETTER_AUTH", "SMTP_", "HELP_"))}
        api_env = {**clean, "NODE_ENV": "development", "LOG_LEVEL": "info", "DATABASE_URL": self.database_url,
                   "PORT": str(self.api_port), "HOST": "127.0.0.1", "APP_URL": self.app_url,
                   "BETTER_AUTH_URL": f"http://localhost:{self.api_port}",
                   "BETTER_AUTH_SECRET": "slop-better-auth-secret-0123456789abcdef",
                   "UPSTREAM_URL": f"http://127.0.0.1:{self.up_port}", "UPSTREAM_TOKEN": UPSTREAM_TOKEN,
                   "UPSTREAM_WS_URL": f"ws://127.0.0.1:{self.up_port}/ws", "RUN_JOBS": "true",
                   "REGISTRATION_OPEN": "true", "STATS_REFRESH_HOUR_UTC": "", "HELP_DEEPSEEK_API_KEY": "",
                   "SMTP_HOST": "", "NODE_OPTIONS": node_opts, "SLOP_GUARD_LOG": str(self.guard_log),
                   **self.api_env}
        self.spawn("api", [str(ROOT / "apps/api/node_modules/.bin/tsx"), "src/server.ts"], cwd=ROOT / "apps/api",
                   env=api_env)
        self.wait_http("api", f"{self.api_url}/healthz", 90)

        web_env = {**clean, "SLOP_API_ORIGIN": self.api_url, "SLOP_WEB_PORT": str(self.web_port),
                   "NODE_OPTIONS": node_opts, "SLOP_GUARD_LOG": str(self.guard_log), "BROWSER": "none"}
        self.spawn("web", [str(ROOT / "apps/web/node_modules/.bin/vite"), "--config",
                           str(LIB / "vite.slop.config.mts")], cwd=ROOT / "apps/web", env=web_env)
        self.wait_http("web", f"{self.app_url}/", 90)
