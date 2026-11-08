#!/usr/bin/env node
// Same pinned toolchain as render-voice-intro.mjs. Exports are evidence, not app resources.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../.shots/scheduled-tasks-demo');
mkdirSync(out, { recursive: true });
for (const theme of ['dark', 'light']) {
  const result = spawnSync('npx', ['-y', '-p', '@remotion/cli@4.0.535', 'remotion', 'render',
    join(here, 'scheduled-tasks-demo-render/entry.tsx'), `ScheduledTasks-${theme}`, join(out, `scheduled-tasks-${theme}.mp4`),
    `--config=${join(here, 'voice-intro-render/remotion.config.js')}`, '--codec=h264', '--crf=20', '--pixel-format=yuv420p', '--concurrency=2', '--overwrite'],
  { cwd: resolve(here, '..'), stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
