#!/usr/bin/env python3
"""LeRobot bridge server — serves a LeRobot policy's `.select_action(obs)` over line-delimited JSON on
stdio, so a skillpack `lerobot` skill (Node) can be driven by a real checkpoint (Python).

  echo '{"method":"select_action","obs":{"state":[0.5,0.5,0.5,0.5,0.5],"target":[0.8,0.3,0.6,0.4,0.7]}}' \
    | python3 lerobot_server.py --checkpoint hf://lerobot/act_so101_pickplace

Loads the real policy when `lerobot` + `torch` are installed; otherwise falls back to a deterministic
mock (proportional-to-target) and says so on stderr, so the BRIDGE PROTOCOL is testable without the full
install. The action always leaves here unclamped — the skillpack runtime safety envelope is what bounds
it, on the Node side.
"""
import sys, json, argparse


def load_policy(checkpoint):
    """Return (mode, fn) where fn(obs)->list[float]. Real LeRobot when available, else a mock."""
    try:
        import torch  # noqa: F401
        from lerobot.common.policies.factory import make_policy  # type: ignore
        # Real load path (version-dependent). Kept in try/except so a missing/renamed API degrades to mock
        # rather than crashing the bridge. When it loads, select_action drives the actual checkpoint.
        policy = make_policy(checkpoint)  # pragma: no cover - exercised only with lerobot installed
        policy.eval()

        def real(obs):  # pragma: no cover
            import torch
            batch = {"observation.state": torch.tensor([obs.get("state", [])], dtype=torch.float32)}
            with torch.no_grad():
                act = policy.select_action(batch)
            return act.squeeze(0).tolist()

        return ("lerobot", real)
    except Exception as e:  # lerobot/torch absent, or API drift → deterministic mock
        sys.stderr.write(f"lerobot unavailable ({type(e).__name__}); using deterministic mock policy\n")

        def mock(obs):
            state = obs.get("state") or []
            target = obs.get("target")
            n = len(state) if state else (len(target) if target else 5)
            if target:
                # propose the target directly; the Node-side envelope ramps it under the velocity cap
                return [float(target[i]) if i < len(target) else 0.5 for i in range(n)]
            return [0.6] * n

        return ("mock", mock)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="mock")
    args = ap.parse_args()
    mode, fn = load_policy(args.checkpoint)
    sys.stderr.write(f"lerobot-bridge ready · checkpoint={args.checkpoint} · mode={mode}\n")
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        method = req.get("method")
        if method == "reset":
            print(json.dumps({"ok": True}), flush=True)
        elif method == "select_action":
            action = fn(req.get("obs", {}))
            print(json.dumps({"action": action, "mode": mode}), flush=True)
        elif method == "shutdown":
            print(json.dumps({"ok": True}), flush=True)
            break
        else:
            print(json.dumps({"error": f"unknown method {method}"}), flush=True)


if __name__ == "__main__":
    main()
