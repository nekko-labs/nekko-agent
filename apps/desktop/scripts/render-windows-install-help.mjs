#!/usr/bin/env node
// Renders the Windows install help videos (browser download warning, SmartScreen on first run)
// in 16:9 for the help page and 9:16 for social. Local previews only: output goes to
// apps/desktop/out/windows-install-help, which is not committed.
//
//   node apps/desktop/scripts/render-windows-install-help.mjs            # all four
//   node apps/desktop/scripts/render-windows-install-help.mjs SmartScreen-16x9
//
// The Remotion CLI is fetched by npx, pinned to the version of `remotion` in package.json.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const out = join(desktop, 'out/windows-install-help');
// The -panel cuts are for the website's download panel: zoomed, large text, a lighter encode.
const ALL = ['EdgeDownload-16x9', 'SmartScreen-16x9', 'EdgeDownload-9x16', 'SmartScreen-9x16', 'EdgeDownload-panel', 'SmartScreen-panel'];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

mkdirSync(out, { recursive: true });
for (const id of ids) {
  const run = spawnSync('npx', ['-y', '-p', '@remotion/cli@4.0.535', 'remotion', 'render',
    join(here, 'windows-install-help/entry.tsx'), id, join(out, `${id}.mp4`),
    `--config=${join(here, 'windows-install-help/remotion.config.js')}`,
    '--codec=h264', `--crf=${id.endsWith('-panel') ? 26 : 20}`, '--pixel-format=yuv420p', '--overwrite'], { cwd: desktop, stdio: 'inherit', shell: process.platform === 'win32' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
