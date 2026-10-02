"""
State paths for the upstream service — the one place they are decided.

`UPSTREAM_STATE_DIR` (`/data` in the image, `./data` in dev) holds every
captured session and the proxy registry. Directories are created 0700 and
`proxies.json` is written 0600 because both hold credentials.
"""
from __future__ import annotations

import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE_DIR = Path(os.environ.get("UPSTREAM_STATE_DIR") or HERE / "data")
SESSIONS_DIR = STATE_DIR / "sessions"
PROXIES_PATH = STATE_DIR / "proxies.json"


def ensure_dir(path: Path) -> Path:
    """mkdir -p `path` (a dir at or under STATE_DIR); every level from
    STATE_DIR down is created 0700. Existing dirs are left as they are."""
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    for d in reversed((path, *path.parents)):
        if STATE_DIR in d.parents:
            d.mkdir(mode=0o700, exist_ok=True)
    return path
