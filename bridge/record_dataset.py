#!/usr/bin/env python3
"""Write a recorded skillpack trajectory as a real LeRobotDataset (state/action, no video), using
LeRobot's own writer so the result is guaranteed valid. Reads a trajectory JSON, emits one RESULT line
of JSON on stdout with the written dataset's stats (verified by reading the parquet back).

  python3 record_dataset.py <trajectory.json> <output_root>
"""
import sys, json, glob

def main():
    real_stdout = sys.stdout
    sys.stdout = sys.stderr                        # keep stdout clean for the one RESULT line
    traj = json.load(open(sys.argv[1]))
    root = sys.argv[2]
    import numpy as np, pyarrow.parquet as pq
    from lerobot.datasets.lerobot_dataset import LeRobotDataset
    sd, ad = traj["state_dim"], traj["action_dim"]
    feats = {
        "observation.state": {"dtype": "float32", "shape": (sd,), "names": [f"j{i}" for i in range(sd)]},
        "action":            {"dtype": "float32", "shape": (ad,), "names": [f"j{i}" for i in range(ad)]},
    }
    ds = LeRobotDataset.create(repo_id="skillpack/recorded", fps=traj["fps"], features=feats, root=root, use_videos=False)
    for ep in traj["episodes"]:
        for fr in ep["frames"]:
            ds.add_frame({"observation.state": np.array(fr["state"], dtype=np.float32),
                          "action": np.array(fr["action"], dtype=np.float32), "task": ep["task"]})
        ds.save_episode()
    ds.finalize()

    files = glob.glob(f"{root}/data/**/*.parquet", recursive=True)
    t = pq.read_table(files[0])
    result = {
        "root": root, "episodes": int(ds.meta.total_episodes), "frames": int(ds.meta.total_frames),
        "parquet_rows": int(t.num_rows), "parquet_cols": list(t.column_names), "state_dim": sd,
    }
    real_stdout.write("RESULT:" + json.dumps(result) + "\n"); real_stdout.flush()

if __name__ == "__main__":
    main()
