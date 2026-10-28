#!/usr/bin/env node
// Renders the first-open video for the iPhone app, light and dark, from the same
// VoiceIntroVideo the desktop plays. The MP4s are app resources and are committed.
//
//   node apps/desktop/scripts/render-voice-intro.mjs
//
// The Remotion CLI is fetched by npx, pinned to the version of `remotion` in
// package.json, so the repo does not carry it. The first run downloads a headless
// Chrome. If the file is over the budget, lower the quality (raise CRF) here.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const out = resolve(desktop, '../ios/App/Resources');
const CRF = 28;
const MAX_BYTES = 3 * 1024 * 1024;

let failed = false;
for (const theme of ['light', 'dark']) {
  const file = join(out, `voice-intro-${theme}.mp4`);
  const run = spawnSync('npx', ['-y', '-p', '@remotion/cli@4.0.535', 'remotion', 'render',
    join(here, 'voice-intro-render/entry.tsx'), `VoiceIntro-${theme}`, file,
    `--config=${join(here, 'voice-intro-render/remotion.config.js')}`,
    '--codec=h264', `--crf=${CRF}`, '--pixel-format=yuv420p', '--overwrite'], { cwd: desktop, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
  const bytes = statSync(file).size;
  console.log(`${file}: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  if (bytes > MAX_BYTES) { console.error('Over 3 MB: raise CRF.'); failed = true; }
}
process.exit(failed ? 1 : 0);
