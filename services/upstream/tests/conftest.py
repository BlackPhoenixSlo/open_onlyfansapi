"""Test env: a throwaway state dir and a known token, set before `app` is imported."""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

os.environ["UPSTREAM_STATE_DIR"] = tempfile.mkdtemp(prefix="upstream-test-")
os.environ["UPSTREAM_TOKEN"] = TOKEN = "test-token-0123456789"
os.environ["OF_REQUIRE_PROXY"] = "true"

import accounts
import client_pool
import config
import proxies

FIXTURES = HERE / "fixtures" / "of_frames"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture(autouse=True)
def clean_state():
    """Every test starts with no accounts, no proxies and an empty client pool."""
    # Never touch a real state dir: every path must come from UPSTREAM_STATE_DIR.
    assert accounts.account_dir("1").is_relative_to(config.STATE_DIR)
    assert "upstream-test-" in str(config.STATE_DIR)
    shutil.rmtree(config.SESSIONS_DIR, ignore_errors=True)
    config.PROXIES_PATH.unlink(missing_ok=True)
    client_pool.evict()
    yield
    client_pool.evict()


def make_account(aid: str, *, session: bool = True, proxy: bool = True, **meta) -> None:
    """An account dir as `from_curl` leaves it; `session=False` is a dir with meta only."""
    accounts.upsert_account(aid, nickname=meta.pop("nickname", f"Account {aid}"))
    if meta:
        m = accounts.load_meta(aid)
        m.update(meta)
        accounts.save_meta(aid, m)
    if session:
        new_session(aid)
    if proxy:
        proxies.upsert({"label": f"acct-{aid}", "scheme": "http", "host": "203.0.113.10", "port": 8080})
        proxies.assign_account(f"acct-{aid}", aid)


def new_session(aid: str, *, bump: float = 0) -> None:
    """Write a new session file and point `latest.json` at it (mtime moved by `bump`)."""
    adir = accounts.account_dir(aid)
    adir.mkdir(parents=True, exist_ok=True)
    n = len(list(adir.glob("session_*.json")))
    path = adir / f"session_2026100{n}T120000Z.json"
    path.write_text(json.dumps({"headers": {"user_id": aid}}))
    accounts.record_session(aid, path)
    if bump:
        latest = adir / "latest.json"
        t = latest.stat().st_mtime + bump
        os.utime(latest, (t, t))


def frame(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())
