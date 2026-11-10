#!/usr/bin/env node
// Renders the phones' "Send your first prompt" demos. The MP4s are app resources and
// are committed; run this again after changing the demos.
//
//   node apps/desktop/scripts/render-first-prompt-intro.mjs            the iPhone's
//     (PhoneDemos.tsx → apps/ios/App/Resources/first-prompt-<step>-<theme>.mp4)
//   node apps/desktop/scripts/render-first-prompt-intro.mjs --android  Android's
//     (AndroidDemos.tsx → apps/android/app/src/main/res/raw/first_prompt_<step>_<theme>.mp4)
//
// Same toolchain as render-voice-intro.mjs (npx-pinned Remotion CLI, its webpack config).
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const android = process.argv.includes('--android');
const out = resolve(desktop, android ? '../android/app/src/main/res/raw' : '../ios/App/Resources');
const entry = join(here, 'first-prompt-intro-render', android ? 'android-entry.tsx' : 'entry.tsx');
// Android resource names allow only a-z, 0-9 and _.
const name = (step, theme) => android ? `first_prompt_${step}_${theme}.mp4` : `first-prompt-${step}-${theme}.mp4`;
const composition = (step, theme) => `${android ? 'FirstPromptAndroid' : 'FirstPrompt'}-${step}-${theme}`;
const CRF = 26;
const MAX_BYTES = 600 * 1024;

let failed = false;
for (const step of ['start', 'add', 'send']) {
  for (const theme of ['light', 'dark']) {
    const file = join(out, name(step, theme));
    const run = spawnSync('npx', ['-y', '-p', '@remotion/cli@4.0.535', 'remotion', 'render',
      entry, composition(step, theme), file,
      `--config=${join(here, 'voice-intro-render/remotion.config.js')}`, '--scale=2',
      '--codec=h264', `--crf=${CRF}`, '--pixel-format=yuv420p', '--muted', '--overwrite'], { cwd: desktop, stdio: 'inherit' });
    if (run.status !== 0) process.exit(run.status ?? 1);
    const bytes = statSync(file).size;
    console.log(`${file}: ${(bytes / 1024).toFixed(0)} KB`);
    if (bytes > MAX_BYTES) { console.error('Over 600 KB: raise CRF.'); failed = true; }
  }
}
process.exit(failed ? 1 : 0);
