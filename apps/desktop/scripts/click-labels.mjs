#!/usr/bin/env node
// The control names a click report may carry (renderer/telemetry.ts): every
// aria-label and data-testid written as fixed text in the renderer's source.
// A label built at runtime (`Open file ${name}`) is never in this list, so a
// click can't report a file, chat or person's name. Run after adding controls:
//   node apps/desktop/scripts/click-labels.mjs
// telemetry.test.ts fails while the committed list is stale.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rendererDir = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer');
export const listPath = join(rendererDir, 'clickLabels.json');

export function collectClickLabels(dir = rendererDir) {
  const labels = new Set();
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = String(entry);
    if (!file.endsWith('.tsx') || /\.test\.tsx$/.test(file)) continue;
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(/(?:aria-label|data-testid)="([^"{}$]{1,60})"/g)) labels.add(m[1]);
  }
  return [...labels].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const labels = collectClickLabels();
  writeFileSync(listPath, `${JSON.stringify(labels, null, 2)}\n`);
  console.log(`${labels.length} click labels written to ${listPath}`);
}
