import json
import stat

import pytest

import config
import proxies

DATA = {"proxies": [{"label": "acct-1", "host": "203.0.113.10", "port": 8080, "password": "pw"}]}


def _stray():
    return [p.name for p in config.STATE_DIR.iterdir() if p.name.startswith(".proxies.")]


def test_save_is_0600_round_trips_and_leaves_no_temp_file():
    proxies.save(DATA)
    assert stat.S_IMODE(config.PROXIES_PATH.stat().st_mode) == 0o600
    assert proxies.load() == DATA
    assert _stray() == []


def test_save_tightens_a_preexisting_loose_file():
    config.PROXIES_PATH.write_text("{}")
    config.PROXIES_PATH.chmod(0o644)
    proxies.save(DATA)
    assert stat.S_IMODE(config.PROXIES_PATH.stat().st_mode) == 0o600


@pytest.mark.parametrize("target", ["json.dump", "os.replace"])
def test_failed_save_keeps_old_file_and_leaves_no_temp_file(monkeypatch, target):
    proxies.save(DATA)
    mod, name = target.split(".")

    def boom(*a, **kw):
        raise OSError("disk full")

    monkeypatch.setattr(getattr(proxies, mod), name, boom)
    with pytest.raises(OSError, match="disk full"):
        proxies.save({"proxies": []})
    monkeypatch.undo()
    assert json.loads(config.PROXIES_PATH.read_text()) == DATA
    assert _stray() == []
