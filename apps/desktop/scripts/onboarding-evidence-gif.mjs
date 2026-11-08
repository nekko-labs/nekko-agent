// Records the setup wizard's welcome animation as a GIF. The hidden Electron
// capture can't run CSS animations, so this loads the same built fixture
// (run onboarding-evidence-sandbox.cjs through layout-evidence-integration.cjs
// first) in headless Chromium, offline, and grabs frames.
// Usage: node apps/desktop/scripts/onboarding-evidence-gif.mjs <fixture folder>
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const writeGif = require('./evidence-gif.cjs');
const dir = path.resolve(process.argv[2] ?? '.shots/layout-evidence/after');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
await page.route(/^(?!file:|data:|blob:)/, (r) => r.abort());
await page.goto('file://' + path.join(dir, 'index.html'));
await page.waitForSelector('.setup-welcome');
const frames = [];
for (let i = 0; i < 30; i++) { frames.push(await page.screenshot()); await page.waitForTimeout(70); }
writeGif(path.join(dir, 'welcome.gif'), frames, 8);
await browser.close();
console.log(path.join(dir, 'welcome.gif'));
