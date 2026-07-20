#!/usr/bin/env python3
"""LeRobot bridge server — serves a LeRobot policy's `.select_action(obs)` over line-delimited JSON on
stdio, so a skillpack `lerobot` skill (Node) can be driven by a real checkpoint (Python).

  # real weights (needs a py>=3.12 venv with `pip install lerobot`):
  echo '{"method":"select_action","obs":{"state":[0.5,0.5,0.5,0.5,0.5]}}' \
    | python3.13 lerobot_server.py --checkpoint lerobot/act_aloha_sim_transfer_cube_human --policy-type act

Loads the real policy when `lerobot` + `torch` are importable; otherwise falls back to a deterministic
mock (proportional-to-target) and says so on stderr, so the BRIDGE PROTOCOL is testable without the full
install. Actions always leave here unclamped — the skillpack runtime safety envelope, on the Node side,
is what bounds them.
"""
import sys, json, argparse

# policy_type -> (module, class). Extend as LeRobot adds architectures; all share .select_action(batch).
POLICY_CLASSES = {
    "act":       ("lerobot.policies.act.modeling_act", "ACTPolicy"),
    "diffusion": ("lerobot.policies.diffusion.modeling_diffusion", "DiffusionPolicy"),
    "pi0":       ("lerobot.policies.pi0.modeling_pi0", "PI0Policy"),
}


def load_policy(checkpoint, policy_type):
    """Return (mode, fn) where fn(obs)->list[float]. Real LeRobot when importable, else a mock."""
    repo = checkpoint.replace("hf://", "")
    try:
        import torch
        mod, cls = POLICY_CLASSES[policy_type]
        Policy = getattr(__import__(mod, fromlist=[cls]), cls)
        policy = Policy.from_pretrained(repo)
        policy.eval()
        policy.reset()
        device = next(policy.parameters()).device
        feats = policy.config.input_features  # name -> feature(shape, type)

        # language-conditioned policies (pi0) need their task string TOKENIZED into language tokens; the
        # lerobot preprocessor pipeline does that (and normalization). ACT/Diffusion self-normalize.
        preprocessor = None
        if policy_type == "pi0":
            from lerobot.policies.factory import make_pre_post_processors
            preprocessor, _ = make_pre_post_processors(policy.config, pretrained_path=repo)

        def real(obs):
            batch = {}
            for name, ft in feats.items():
                shape = tuple(ft.shape)
                if "state" in name and obs.get("state"):
                    st = list(obs["state"])[: shape[0]]
                    st += [0.0] * max(0, shape[0] - len(st))          # pad the robot state to the policy's dim
                    batch[name] = torch.tensor([st], dtype=torch.float32, device=device)
                else:
                    batch[name] = torch.zeros((1,) + shape, dtype=torch.float32, device=device)  # e.g. camera
            if obs.get("task") is not None or policy_type == "pi0":
                batch["task"] = [obs.get("task") or "reach the target"]
            if preprocessor is not None:
                batch = preprocessor(batch)                            # tokenize task -> language tokens
            with torch.no_grad():
                act = policy.select_action(batch)
            return act.squeeze(0).float().cpu().tolist()

        return (f"lerobot:{policy_type}", real)
    except Exception as e:  # lerobot/torch absent, or a load error → deterministic mock
        sys.stderr.write(f"lerobot unavailable ({type(e).__name__}: {str(e)[:80]}); using deterministic mock\n")

        def mock(obs):
            state = obs.get("state") or []
            target = obs.get("target")
            n = len(state) if state else (len(target) if target else 5)
            if target:
                return [float(target[i]) if i < len(target) else 0.5 for i in range(n)]
            return [0.6] * n

        return ("mock", mock)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="mock")
    ap.add_argument("--policy-type", default="act", choices=list(POLICY_CLASSES))
    args = ap.parse_args()
    mode, fn = load_policy(args.checkpoint, args.policy_type)
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
            print(json.dumps({"action": fn(req.get("obs", {})), "mode": mode}), flush=True)
        elif method == "shutdown":
            print(json.dumps({"ok": True}), flush=True)
            break
        else:
            print(json.dumps({"error": f"unknown method {method}"}), flush=True)


if __name__ == "__main__":
    main()
