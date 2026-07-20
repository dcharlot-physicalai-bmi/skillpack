#!/usr/bin/env python3
"""MuJoCo physics bridge — a REAL rigid-body arm that the skillpack runtime drives, so a skill's
safety-bounded commands are evaluated against actual dynamics (gravity, inertia, coupling) instead of a
kinematic approximation. Line-delimited JSON on stdio, like the lerobot bridge.

  {"method":"reset","q0":[0.5,0.5,0.5,0.5,0.5]}            -> {"qpos":[...], "tip":[x,y,z]}
  {"method":"step","cmd":[0.6,0.4,0.5,0.5,0.5]}            -> {"qpos":[...], "tip":[x,y,z]}   (normalized 0..1)

The skillpack runtime speaks normalized joint positions [0,1]; here 0.5 = 0 rad, mapped to [-R, R].
"""
import sys, json

R = 1.4          # normalized [0,1] maps to joint angle [-R, R]  (0.5 -> 0 rad)
SUBSTEPS = 8     # physics steps per control tick (~20 Hz control, 0.002 s dt)

# a 5-DoF planar arm that tracks position commands under gravity (light links, per-joint kp down the chain)
LINKS = [(0.18, 0.30, 100), (0.16, 0.25, 60), (0.14, 0.20, 42), (0.12, 0.15, 30), (0.12, 0.12, 22)]
def build_xml():
    body = '<site name="tip" pos="0.12 0 0"/>'
    for i in range(len(LINKS) - 1, -1, -1):
        l, mass, _ = LINKS[i]
        pos = '0 0 0.7' if i == 0 else f'{LINKS[i-1][0]} 0 0'
        body = f'<body pos="{pos}"><joint name="j{i}" type="hinge" axis="0 1 0" damping="0.4"/>' \
               f'<geom type="capsule" fromto="0 0 0 {l} 0 0" size="0.02" mass="{mass}"/>{body}</body>'
    acts = ''.join(f'<position joint="j{i}" kp="{kp}" ctrlrange="-3 3"/>' for i, (_, _, kp) in enumerate(LINKS))
    return f'<mujoco><option gravity="0 0 -9.81"/><worldbody>{body}</worldbody><actuator>{acts}</actuator></mujoco>'

def main():
    real_stdout = sys.stdout
    sys.stdout = sys.stderr                       # keep stdout clean for JSON only
    def emit(o): real_stdout.write(json.dumps(o) + "\n"); real_stdout.flush()

    try:
        import mujoco, numpy as np
        m = mujoco.MjModel.from_xml_string(build_xml())
        d = mujoco.MjData(m)
        tip_id = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_SITE, "tip")
        mode = f"mujoco:{m.nu}dof"
    except Exception as e:
        sys.stderr.write(f"mujoco unavailable ({type(e).__name__}: {str(e)[:80]})\n"); m = None
        mode = "unavailable"

    def norm2ctrl(c): return [(x - 0.5) * 2 * R for x in c]
    def q2norm(): return [max(0.0, min(1.0, float(q) / (2 * R) + 0.5)) for q in d.qpos]
    def tip(): return [round(float(x), 4) for x in d.site_xpos[tip_id]]

    sys.stderr.write(f"mujoco-bridge ready · mode={mode}\n"); sys.stderr.flush()
    if m is None:
        for _ in sys.stdin: emit({"error": "mujoco unavailable"})
        return
    import mujoco
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: req = json.loads(line)
        except Exception: continue
        meth = req.get("method")
        if meth == "reset":
            mujoco.mj_resetData(m, d)
            q0 = req.get("q0")
            if q0:
                for i, v in enumerate(norm2ctrl(q0)[: m.nq]): d.qpos[i] = v; d.ctrl[i] = v
            mujoco.mj_forward(m, d)
            emit({"qpos": q2norm(), "tip": tip(), "mode": mode})
        elif meth == "step":
            cmd = norm2ctrl(req.get("cmd", []))
            for i, v in enumerate(cmd[: m.nu]): d.ctrl[i] = v
            for _ in range(SUBSTEPS): mujoco.mj_step(m, d)
            emit({"qpos": q2norm(), "tip": tip(), "mode": mode})
        elif meth == "shutdown":
            emit({"ok": True}); break
        else:
            emit({"error": f"unknown method {meth}"})

if __name__ == "__main__":
    main()
