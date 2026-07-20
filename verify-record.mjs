// verify-record.mjs — the learning loop closes: record a skill's execution → a real LeRobotDataset →
// (train with LeRobot → the checkpoint is a lerobot-kind skill). Records arm-reach, writes the dataset
// via lerobot's own writer, and reads the parquet + meta back to confirm it's valid. Auto-skips w/o venv.
//   node v2/skillpack/verify-record.mjs

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadSkill } from './skillkit.mjs';
import { recordEpisodes } from './record.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENV_PY = process.env.VENV_PY || join(HERE, '.venv-lerobot/bin/python');
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const robot = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));
const reach = await loadSkill(join(HERE, 'skills/arm-reach'));
const targets = [[0.7, 0.35, 0.6, 0.45, 0.55], [0.3, 0.6, 0.45, 0.5, 0.5], [0.6, 0.4, 0.65, 0.4, 0.6]];

console.log(h('record arm-reach demonstrations (envelope-bounded actions)'));
const traj = await recordEpisodes(reach, so101(), targets, {});
function so101() { return robot; }
const totalFrames = traj.episodes.reduce((a, e) => a + e.frames.length, 0);
check('recorded episodes with frames', traj.episodes.length === targets.length && totalFrames > 0, `${traj.episodes.length} episodes, ${totalFrames} frames`);
// the recorded actions are safety-bounded (envelope-clean training data)
const allActions = traj.episodes.flatMap((e) => e.frames.flatMap((f) => f.action));
check('every recorded action is in [0,1] (envelope-clean demonstrations)', allActions.every((v) => v >= 0 && v <= 1 && Number.isFinite(v)));

if (!existsSync(VENV_PY)) {
  console.log(h('LeRobotDataset write — SKIPPED (no venv)'));
  console.log(`  ⚪ npm run setup:lerobot installs the dataset deps; the recorder itself is verified above.`);
  process.exit(fails === 0 ? 0 : 1);
}

console.log(h('write a real LeRobotDataset (lerobot\'s own writer) and read it back'));
const dir = await mkdtemp(join(tmpdir(), 'skillpack-rec-'));
const trajPath = join(dir, 'traj.json'), dsRoot = join(dir, 'ds');
await writeFile(trajPath, JSON.stringify(traj));
const r = spawnSync(VENV_PY, [join(HERE, 'bridge/record_dataset.py'), trajPath, dsRoot], { encoding: 'utf8', env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1' } });
const line = ((r.stdout || '') + '').split('\n').find((l) => l.startsWith('RESULT:'));
if (!line) { console.log('  ❌ writer produced no RESULT', (r.stderr || '').split('\n').slice(-3).join(' ')); process.exit(1); }
const res = JSON.parse(line.slice(7));
check('LeRobotDataset written with the recorded episodes', res.episodes === traj.episodes.length, `${res.episodes} episodes`);
check('frame count matches the recording', res.frames === totalFrames, `${res.frames} frames == ${totalFrames}`);
check('parquet has the LeRobot columns (observation.state, action, episode_index)', ['observation.state', 'action', 'episode_index'].every((c) => res.parquet_cols.includes(c)),
      res.parquet_cols.filter((c) => ['observation.state', 'action', 'timestamp', 'episode_index', 'frame_index', 'task_index'].includes(c)).join(', '));
check('parquet rows == frames', res.parquet_rows === totalFrames);
// independently read the dataset's info.json off disk
const info = JSON.parse(await readFile(join(dsRoot, 'meta/info.json'), 'utf8'));
check('meta/info.json agrees (episodes + frames + fps)', info.total_episodes === traj.episodes.length && info.total_frames === totalFrames && info.fps === traj.fps,
      `info: ${info.total_episodes} eps, ${info.total_frames} frames, ${info.fps} fps`);
await rm(dir, { recursive: true, force: true });

console.log(h(fails === 0
  ? '✅ learning loop verified — skill execution → a real LeRobotDataset (envelope-clean), ready to train'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
