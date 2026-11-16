// Captures nekkoagent.com for the help videos' browser backdrop, at the stage's page width,
// and records where the Windows download button sits so the cursor can click it exactly.
//   node apps/desktop/scripts/windows-install-help/capture-site.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), 'public');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 804 }, colorScheme: 'dark', reducedMotion: 'reduce' });
await page.goto('https://nekkoagent.com/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, 'site.png'), clip: { x: 0, y: 0, width: 1600, height: 1600 }, fullPage: true });
const btn = page.getByRole('link', { name: /Download for Windows/i }).or(page.getByRole('button', { name: /Download for Windows/i })).first();
const box = await btn.boundingBox();
writeFileSync(join(out, 'site.json'), JSON.stringify({ download: box }, null, 2));
console.log(JSON.stringify(box));
await browser.close();
