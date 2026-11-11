// Renders Settings > Phone pairing > Organization against a stub bridge and screenshots every state in
// Light Nekko and Dusk at desktop and phone widths. Playwright's Chromium (never Edge) in a throwaway profile;
// the browser's whole process tree is ended and its profile deleted on the way out.
// Output: .shots/org-settings-evidence (untracked). Usage: node scripts/org-settings-evidence.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser } from './perf/lib/browser.mjs';
import { connectCdp } from './perf/lib/cdp.mjs';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, '.shots/org-settings-evidence');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const paths = [join(repo, 'apps/desktop'), repo];

const esbuild = require(require.resolve('esbuild', { paths }));
await esbuild.build({
  entryPoints: [join(repo, 'scripts/org-settings-evidence-fixture.tsx')], bundle: true, jsx: 'automatic', format: 'iife',
  conditions: ['style', 'browser', 'import', 'default'], outfile: join(out, 'fixture.js'),
  nodePaths: [join(repo, 'node_modules')], alias: { '@nekko-agent/shared': join(repo, 'packages/shared/src/index.ts') },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, logLevel: 'error',
});
const postcss = require(require.resolve('postcss', { paths }));
const tailwind = require(require.resolve('@tailwindcss/postcss', { paths }));
const css = await postcss([tailwind({ base: repo })]).process(readFileSync(join(out, 'fixture.css'), 'utf8'), { from: join(out, 'fixture.css') });
writeFileSync(join(out, 'styled.css'), css.css);
writeFileSync(join(out, 'index.html'), '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');

const states = ['locked', 'setup', 'plan', 'invite', 'empty', 'full', 'missing-key', 'unavailable'];
const sizes = [['desktop', 900], ['phone', 380]];
const checks = [];
const check = (name, passed) => { checks.push({ name, passed: !!passed }); if (!passed) console.error('FAILED', name); };

const browser = await launchBrowser({ port: 9411, width: 1000, height: 900 });
let cdp;
try {
  cdp = await connectCdp(browser.wsUrl);
  await cdp.send('Page.enable');
  const url = pathToFileURL(join(out, 'index.html')).href;
  for (const [sizeName, width] of sizes) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const state of states) {
      for (const theme of ['light', 'dark']) {
        await cdp.send("Page.navigate", { url: `${url}?s=${state}&t=${theme}&w=${width}` });
        await sleep(900);
        await cdp.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        await sleep(300);
        const label = `${state}-${sizeName}-${theme}`;
        const rect = await cdp.evaluate("(() => { const r = document.querySelector('main').getBoundingClientRect(); return { x: 0, y: 0, width: innerWidth, height: Math.ceil(r.height) }; })()");
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: true });
        writeFileSync(join(out, `${label}.png`), Buffer.from(shot.data, 'base64'));
        check(`${label}: no horizontal overflow`, await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
        check(`${label}: section rendered`, await cdp.evaluate("!!document.querySelector('[data-testid=org-settings]')"));
        if (state === 'full' && theme === 'light' && sizeName === 'desktop') {
          check('full: three computers', await cdp.evaluate("document.querySelectorAll('[data-testid=org-computer]').length === 3"));
          check('full: models collapse after 3', await cdp.evaluate("document.querySelector('[data-testid=org-more-models]')?.textContent === '+2 more'"));
          await cdp.evaluate("document.querySelector('[role=switch]').click()");
          await sleep(500);
          check('full: switch calls fleet:setSharing off', await cdp.evaluate("JSON.stringify(window.__calls[0]) === JSON.stringify(['fleet:setSharing','org1',false])"));
          check('full: no Connect or Run button', await cdp.evaluate("![...document.querySelectorAll('button')].some((b) => /^(connect|run)$/i.test(b.textContent.trim()))"));
        }
      }
    }
  }
} finally {
  try { cdp?.close(); } catch { /* closed */ }
  await browser.close();
}
writeFileSync(join(out, 'status.json'), JSON.stringify({ checks }, null, 2));
const failed = checks.filter((c) => !c.passed);
console.log(`${checks.length} checks, ${failed.length} failed; screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
