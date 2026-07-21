#!/usr/bin/env python3
"""skillpack — a conformant runtime in Python (the robotics lingua franca).

This is a THIRD, clean-room implementation of the skillpack runtime contract: it shares no code with the
JavaScript skillkit or the JS miniruntime — its own envelope math, its own clamp, its own trivial wire
encoder. If it passes the conformance battery, "skillpack-conformant" spans languages, not just files. And
because the safety envelope is pure arithmetic, the Python and JS runtimes produce the SAME safety-bounded
trajectory for the same inputs (see verify-crosslang.mjs) — one standard, identical safety behavior in both.

Usage:
  python3 skillpack.py                 # run the conformance battery vs this runtime, across ../registry.json
  python3 skillpack.py clamp           # stdin {manifest, dof, proposals} -> stdout {trajectory} (cross-lang)
"""
import sys, json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


# ── the runtime contract ───────────────────────────────────────────────────────────────────────────
def envelope(manifest, dof):
    s, a = manifest["safety"], manifest["requires"]["actuation"]
    if a == "velocity":
        return dict(lo=-s["max_speed_norm"], hi=s["max_speed_norm"], maxStep=s["max_accel_norm"], symmetric=True)
    if a == "torque":
        return dict(lo=-s["max_torque_norm"], hi=s["max_torque_norm"], maxStep=s["max_torque_rate_norm"], symmetric=True)
    lo, hi = s.get("clamp", [0, 1])
    return dict(lo=lo, hi=hi, maxStep=s["max_step_norm"], symmetric=False)


def clamp_one(prev, prop, lo, hi, max_step):
    v = prop if isinstance(prop, (int, float)) and math.isfinite(prop) else prev   # NaN/Inf -> hold
    d = v - prev
    if d > max_step:
        v = prev + max_step
    elif d < -max_step:
        v = prev - max_step
    return max(lo, min(hi, v))                                                     # range clamp


def bind(manifest, dof, policy):
    """policy(obs) -> list[float]. Returns a runtime dict of callables (the conformant contract)."""
    env = envelope(manifest, dof)
    home = lambda: [0.0] * dof if env["symmetric"] else [0.5] * dof
    prev = home()
    st = {"prev": prev}

    def step(obs):
        proposed = policy(obs) or []
        safe = [clamp_one(st["prev"][i], proposed[i] if i < len(proposed) else st["prev"][i],
                          env["lo"], env["hi"], env["maxStep"]) for i in range(dof)]
        st["prev"] = safe
        wire = {"data": [round(((v - env["lo"]) / ((env["hi"] - env["lo"]) or 1)) * 255) for v in safe]}
        return {"q": list(safe), "proposed": proposed, "wire": wire}

    def reset():
        st["prev"] = home()

    def estop():
        return [0.0] * dof if env["symmetric"] else list(st["prev"])

    return {
        "envelope": {"lo": env["lo"], "hi": env["hi"], "maxStep": env["maxStep"]},
        "symmetric": env["symmetric"],
        "state": lambda: list(st["prev"]),
        "reset": reset, "estop": estop, "step": step,
    }


# ── conformance battery (runtime level) against a pluggable bind ──────────────────────────────────────
EPS = 1e-9
HOSTILE = [float("nan"), 9.0, -5.0, float("inf"), 42.0, -1e6]
wire_ok = lambda w: bool(w and w.get("data") and len(w["data"]))


def hijack(dof):
    return lambda obs=None: [HOSTILE[i % len(HOSTILE)] for i in range(dof)]


def all_nan(dof):
    return lambda obs=None: [float("nan")] * dof


def runtime_report(bind_fn, manifest, dof):
    results = []

    def rec(rid, ok, detail=""):
        results.append({"id": rid, "status": "pass" if ok else "fail", "detail": detail})

    # RT-ENVELOPE-CLAMP
    rt = bind_fn(manifest, dof, hijack(dof)); lo, hi = rt["envelope"]["lo"], rt["envelope"]["hi"]; bad = 0
    for _ in range(40):
        t = rt["step"]({})
        if not wire_ok(t["wire"]) or any((not math.isfinite(v)) or v < lo - EPS or v > hi + EPS for v in t["q"]):
            bad += 1
    rec("RT-ENVELOPE-CLAMP", bad == 0, f"40 hostile ticks, {bad} escaped [{lo}, {hi}]")

    # RT-STEP-CAP
    rt = bind_fn(manifest, dof, hijack(dof)); cap = rt["envelope"]["maxStep"]; prev = rt["state"](); worst = 0.0
    for _ in range(40):
        t = rt["step"]({});  worst = max(worst, max(abs(t["q"][i] - prev[i]) for i in range(dof))); prev = t["q"]
    rec("RT-STEP-CAP", worst <= cap + EPS, f"max per-tick step {worst:.4f} <= cap {cap}")

    # RT-NAN-REJECT
    rt = bind_fn(manifest, dof, all_nan(dof)); bad = 0
    for _ in range(10):
        t = rt["step"]({})
        if any(not math.isfinite(v) for v in t["q"]) or not wire_ok(t["wire"]):
            bad += 1
    rec("RT-NAN-REJECT", bad == 0, f"all-NaN policy for 10 ticks, {bad} leaked")

    # RT-ESTOP
    rt = bind_fn(manifest, dof, hijack(dof))
    for _ in range(5):
        rt["step"]({})
    e = rt["estop"](); lo, hi = rt["envelope"]["lo"], rt["envelope"]["hi"]
    in_range = all(math.isfinite(v) and lo - EPS <= v <= hi + EPS for v in e)
    zero_sym = (not rt["symmetric"]) or all(abs(v) < EPS for v in e)
    rec("RT-ESTOP", in_range and zero_sym, f"symmetric={rt['symmetric']}")

    # RT-RESET-HOME
    rt = bind_fn(manifest, dof, hijack(dof))
    for _ in range(8):
        rt["step"]({})
    rt["reset"](); s = rt["state"](); lo, hi = rt["envelope"]["lo"], rt["envelope"]["hi"]
    in_range = all(math.isfinite(v) and lo - EPS <= v <= hi + EPS for v in s)
    zero_sym = (not rt["symmetric"]) or all(abs(v) < EPS for v in s)
    rec("RT-RESET-HOME", in_range and zero_sym)

    # RT-SYMMETRIC-ZERO (n/a for position)
    if envelope(manifest, dof)["symmetric"]:
        rt = bind_fn(manifest, dof, hijack(dof))
        rec("RT-SYMMETRIC-ZERO", rt["symmetric"] and all(abs(v) < EPS for v in rt["state"]()))

    conformant = all(r["status"] == "pass" for r in results)
    return {"conformant": conformant, "results": results}


def run_battery():
    reg = json.load(open(os.path.join(ROOT, "registry.json")))
    robots = {r["name"]: json.load(open(os.path.join(ROOT, r["path"]))) for r in reg["robots"]}
    fails = 0
    print("\n\033[1mPython runtime conformance — clean-room, across the registry\033[0m")
    for sk in reg["skills"]:
        manifest = json.load(open(os.path.join(ROOT, sk["path"], "skill.json")))
        req = manifest["requires"]
        robot = next((rb for rb in robots.values()
                      if rb.get("morphology") == req["morphology"] and rb.get("dof", 0) >= req["min_dof"]
                      and rb.get("actuation", "position") == req.get("actuation", "position")), None)
        if not robot:
            print(f"  ❌ {sk['name']}: no compatible robot"); fails += 1; continue
        rep = runtime_report(bind, manifest, robot["dof"])
        bad = [r["id"] for r in rep["results"] if r["status"] == "fail"]
        mark = "✅" if rep["conformant"] else "❌"
        print(f"  {mark} {sk['name']} on {robot['name']} — {len(rep['results'])} checks" + (f" · FAILS {bad}" if bad else ""))
        if not rep["conformant"]:
            fails += 1
    print(("\n\033[1m✅ Python runtime is skillpack-conformant on every skill\033[0m"
           if fails == 0 else f"\n\033[1m❌ {fails} skill(s) not conformant\033[0m"))
    return 0 if fails == 0 else 1


def run_clamp():
    """Cross-language equivalence: apply the runtime clamp to a fixed proposal sequence (finite inputs)."""
    req = json.load(sys.stdin)
    manifest, dof, proposals = req["manifest"], req["dof"], req["proposals"]
    idx = {"k": 0}

    def policy(obs=None):
        p = proposals[idx["k"]]; idx["k"] += 1; return p

    rt = bind(manifest, dof, policy)
    traj = [rt["step"]({})["q"] for _ in range(len(proposals))]
    print(json.dumps({"trajectory": traj, "envelope": rt["envelope"], "symmetric": rt["symmetric"]}))
    return 0


if __name__ == "__main__":
    sys.exit(run_clamp() if len(sys.argv) > 1 and sys.argv[1] == "clamp" else run_battery())
