// Screenshots of the Claude Agent UI from claude-agent-fixture.tsx, in headless
// Chromium (no window on screen). Writes only to this worktree's ignored .shots.
//   node apps/desktop/scripts/claude-agent-capture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const out = path.join(repo, '.shots/claude-agent');
fs.mkdirSync(out, { recursive: true });

await require('esbuild').build({
  entryPoints: [path.join(here, 'claude-agent-fixture.tsx')],
  bundle: true,
  jsx: 'automatic',
  conditions: ['style', 'browser', 'import', 'default'],
  format: 'iife',
  outfile: path.join(out, 'fixture.js'),
  nodePaths: [path.join(repo, 'node_modules')],
  alias: { '@nekko-agent/shared': path.join(repo, 'packages/shared/src/index.ts') },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' },
});
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');
const css = await postcss([tailwind({ base: repo })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), {
  from: path.join(out, 'fixture.css'),
});
fs.writeFileSync(path.join(out, 'styled.css'), css.css);

const { chromium } = require('playwright-core');
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['dark', 'light']) {
    const html = `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`;
    fs.writeFileSync(path.join(out, `index-${theme}.html`), html);
    const page = await browser.newPage({ viewport: { width: 880, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('file://' + path.join(out, `index-${theme}.html`).replaceAll('\\', '/'));
    for (const scene of ['choices', 'checking', 'missing', 'signedOut', 'plan', 'apiKey', 'api', 'connected', 'another', 'confirm', 'blocked', 'sheet', 'schedule', 'notice', 'retired', 'limits', 'connect']) {
      await page.evaluate((s) => window.integration.show(s), scene);
      await page.waitForTimeout(250);
      if (scene === 'missing') await page.getByRole('button', { name: 'Install Claude Code' }).click();
      if (scene === 'api') {
        await page.getByRole('radio', { name: 'API' }).click();
        await page.getByRole('button', { name: 'Connect: add a key or cloud account' }).click();
      }
      if (['another', 'confirm', 'blocked'].includes(scene)) {
        await page.getByRole('button', { name: '+ Another subscription account' }).click();
        await page.getByLabel('Name for the other account').fill('Work');
        await page.waitForTimeout(700);
      }
      await page.screenshot({ path: path.join(out, `${scene}-${theme}.png`), fullPage: true });
    }
    if (errors.length) throw new Error(`page errors (${theme}): ${errors.join('; ')}`);
    await page.close();
  }
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
