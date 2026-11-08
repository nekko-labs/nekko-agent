#!/usr/bin/env node
// Renders the iPhone's "Send your first prompt" demos (first-prompt-<step>-<theme>.mp4),
// drawn in scripts/first-prompt-intro-render/PhoneDemos.tsx. The MP4s are app resources
// and are committed; run this again after changing the demos.
//
//   node apps/desktop/scripts/render-first-prompt-intro.mjs
//
// Same toolchain as render-voice-intro.mjs (npx-pinned Remotion CLI, its webpack config).
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const out = resolve(desktop, '../ios/App/Resources');
const CRF = 26;
const MAX_BYTES = 600 * 1024;

let failed = false;
for (const step of ['start', 'add', 'send']) {
  for (const theme of ['light', 'dark']) {
    const file = join(out, `first-prompt-${step}-${theme}.mp4`);
    const run = spawnSync('npx', ['-y', '-p', '@remotion/cli@4.0.535', 'remotion', 'render',
      join(here, 'first-prompt-intro-render/entry.tsx'), `FirstPrompt-${step}-${theme}`, file,
      `--config=${join(here, 'voice-intro-render/remotion.config.js')}`, '--scale=2',
      '--codec=h264', `--crf=${CRF}`, '--pixel-format=yuv420p', '--muted', '--overwrite'], { cwd: desktop, stdio: 'inherit' });
    if (run.status !== 0) process.exit(run.status ?? 1);
    const bytes = statSync(file).size;
    console.log(`${file}: ${(bytes / 1024).toFixed(0)} KB`);
    if (bytes > MAX_BYTES) { console.error('Over 600 KB: raise CRF.'); failed = true; }
  }
}
process.exit(failed ? 1 : 0);
