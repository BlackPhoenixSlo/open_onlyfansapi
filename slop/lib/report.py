"""Checks and evidence for one scenario run. A scenario calls ctx.check(name, ok, **detail) and
ctx.metric(key, value); write() leaves assertions.json, assertions.txt and metrics.json in the run folder."""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

SLOP = Path(__file__).resolve().parents[1]
ROOT = SLOP.parent
RUNS = SLOP / "runs"


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True).stdout.strip()


def run_dir(scenario: str, fault: str | None) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    d = RUNS / f"{stamp}-{git('rev-parse', '--short', 'HEAD')}-{scenario}{'-fault-' + fault if fault else ''}"
    (d / "screenshots").mkdir(parents=True, exist_ok=True)
    return d


def p95(xs: list[float]) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(0.95 * (len(xs) - 1))))]


def last_green(out: Path, scenario: str) -> dict | None:
    """metrics.json of the newest earlier PASS run of this scenario without a fault."""
    for d in sorted(out.parent.iterdir(), reverse=True):
        if d == out or not d.name.endswith(f"-{scenario}"):
            continue
        m = d / "metrics.json"
        if m.exists():
            data = json.loads(m.read_text())
            if data.get("verdict") == "PASS" and not data.get("fault"):
                return {**data, "run": d.name}
    return None


def check_p95(ctx, out: Path, ms: list[float]) -> None:
    """`p95-vs-last-green`: this run's p95 (metric `api_p95_ms`) within 2x + 250 ms of the last green run's."""
    now = p95(ms)
    ctx.metric("api_p95_ms", now)
    ctx.metric("api_calls_timed", len(ms))
    prev = last_green(out, ctx.scenario)
    if prev is None or prev.get("api_p95_ms") is None:
        ctx.check("p95-vs-last-green", now is not None, p95_ms=now, baseline="none (this run sets it)")
    else:
        limit = 2 * prev["api_p95_ms"] + 250
        ctx.check("p95-vs-last-green", now is not None and now <= limit, p95_ms=now, last_green=prev["run"],
                  last_green_p95_ms=prev["api_p95_ms"], limit_ms=limit)


class Report:
    def __init__(self, scenario: str, out: Path, fault: str | None):
        self.scenario, self.out, self.fault = scenario, out, fault
        self.checks: list[dict] = []
        self.metrics: dict = {}
        self.infra: str | None = None  # the stack or the scenario itself broke: no verdict

    def check(self, name: str, ok: bool, **detail) -> bool:
        if any(c["name"] == name for c in self.checks):
            raise ValueError(f"check {name!r} recorded twice")
        status = "PASS" if ok else "FAIL"
        self.checks.append({"name": name, "status": status, "detail": detail})  # detail apart: it may hold a "status"
        print(f"  [{status}] {name} {json.dumps(detail, default=str)[:400]}", flush=True)
        return bool(ok)

    def metric(self, key: str, value) -> None:
        self.metrics[key] = value

    @property
    def ok(self) -> bool:
        return not self.infra and bool(self.checks) and all(c["status"] == "PASS" for c in self.checks)

    def write(self) -> None:
        verdict = "INFRA FAILURE" if self.infra else "PASS" if self.ok else "FAIL"
        meta = {"scenario": self.scenario, "fault": self.fault, "verdict": verdict, "infra": self.infra,
                "git_sha": git("rev-parse", "HEAD"), "git_dirty": bool(git("status", "--porcelain")),
                "finished_at": datetime.now(timezone.utc).isoformat()}
        (self.out / "assertions.json").write_text(json.dumps({**meta, "checks": self.checks}, indent=2, default=str))
        (self.out / "metrics.json").write_text(json.dumps({**meta, **self.metrics}, indent=2, default=str))
        lines = [f"scenario {self.scenario}{' (fault ' + self.fault + ')' if self.fault else ''}: {verdict}",
                 f"git {meta['git_sha']}{' (dirty)' if meta['git_dirty'] else ''}"]
        lines += [f"infra: {self.infra}"] if self.infra else []
        lines += [""] + [f"{c['status']}  {c['name']}" for c in self.checks]
        shots = sorted(str(p.relative_to(self.out)) for p in (self.out / "screenshots").glob("*.png"))
        lines += ["", "screenshots:"] + [f"  {s}" for s in shots]
        (self.out / "assertions.txt").write_text("\n".join(lines) + "\n")
