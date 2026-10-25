"""slop/run <scenario|all> [--fault <name>] | --list

Each scenario is slop/scenarios/<name>.py with `async def run(ctx)` (and optionally FAULTS: the fault names it
supports). A run writes slop/runs/<UTC stamp>-<git short sha>-<scenario>[-fault-<name>]/ and prints its name.
Exit 0: every check passed; 1: a check failed; 3: infra (the stack did not come up or the scenario crashed)."""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import signal
import sys
import traceback
from pathlib import Path

LIB = Path(__file__).resolve().parent
sys.path.insert(0, str(LIB))
import guard
from report import Report, run_dir

SCENARIOS = LIB.parent / "scenarios"


def scenarios() -> dict[str, Path]:
    return {p.stem: p for p in sorted(SCENARIOS.glob("*.py")) if not p.name.startswith("_")}


def load(path: Path):
    spec = importlib.util.spec_from_file_location(f"slop_scenario_{path.stem.replace('-', '_')}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_one(name: str, path: Path, fault: str | None) -> int:
    out = run_dir(name, fault)
    guard.install(str(out / "offhost-refused.jsonl"))
    report = Report(name, out, fault)
    print(f"== {name}{' --fault ' + fault if fault else ''} -> {out.name}", flush=True)
    try:
        mod = load(path)
        if fault and fault not in getattr(mod, "FAULTS", {}):
            raise SystemExit(f"{name} has no fault {fault!r}; it has {sorted(getattr(mod, 'FAULTS', {}))}")
        asyncio.run(mod.run(report, out, fault))
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — infra: the stack or the scenario broke
        report.infra = f"{type(e).__name__}: {e}"
        (out / "scenario-traceback.txt").write_text(traceback.format_exc())
        print(f"  [INFRA] {report.infra}", flush=True)
    report.write()
    print((out / "assertions.txt").read_text(), flush=True)
    print(f"run folder: {out.name}", flush=True)
    return 3 if report.infra else 0 if report.ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(prog="slop/run")
    ap.add_argument("scenario", nargs="?")
    ap.add_argument("--fault")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    found = scenarios()
    if a.list or not a.scenario:
        for n, p in found.items():
            print(n, sorted(getattr(load(p), "FAULTS", {})))
        return 0
    if a.scenario == "all":
        if a.fault:
            raise SystemExit("--fault needs one scenario")
        picked = found
    else:
        picked = {n: p for n, p in found.items() if a.scenario in n}
        if not picked:
            raise SystemExit(f"no scenario matches {a.scenario!r}: {sorted(found)}")
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    worst = 0
    for n, p in picked.items():
        worst = max(worst, run_one(n, p, a.fault))
    return worst


if __name__ == "__main__":
    raise SystemExit(main())
