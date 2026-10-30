// Drives Recordly (the screen recorder) the same way the runner drives the
// app: over a local debugging port. Recordly has no command line or start/stop
// hotkey, but it is an Electron app, so its own HUD buttons can be pressed.
// Started here with the port if it is not already running with it.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXE = process.env.RECORDLY_EXE || 'C:\\Program Files\\Recordly\\Recordly.exe';

async function hud(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('windowType=hud-overlay'));
  if (!page) { await browser.close().catch(() => {}); return null; }
  return { browser, page };
}

const up = (port) => fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);

/** Start Recordly with its debugging port, closing a copy that is open without it or showing its editor. */
async function launch(port) {
  if (process.platform === 'win32') spawn('taskkill', ['/IM', 'Recordly.exe', '/F'], { stdio: 'ignore' });
  await sleep(2500);
  if (!existsSync(EXE)) throw new Error(`Recordly not found at ${EXE}; set RECORDLY_EXE.`);
  spawn(EXE, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) { if (await up(port)) break; await sleep(500); }
  for (let i = 0; i < 30; i++) { const h = await hud(port).catch(() => null); if (h) return h; await sleep(500); }
  throw new Error('Recordly did not open its control bar.');
}

/** Where Recordly saves takes (its own setting), or null if unknown. */
function recordingsDir() {
  try {
    const file = join(process.env.APPDATA ?? '', 'Recordly', 'recordings-settings.json');
    return JSON.parse(readFileSync(file, 'utf8')).recordingsDir ?? null;
  } catch { return null; }
}

function newestTake(dir, since) {
  if (!dir || !existsSync(dir)) return null;
  const takes = readdirSync(dir).filter((f) => /^recording-\d+\.(mp4|webm|mov)$/.test(f))
    .map((f) => ({ path: join(dir, f), at: statSync(join(dir, f)).mtimeMs }))
    .filter((t) => t.at >= since)
    .sort((a, b) => b.at - a.at);
  return takes[0]?.path ?? null;
}

export async function recordly({ port = 9334 } = {}) {
  // A fresh Recordly for every take: after a take it shows its editor instead
  // of the control bar, and after a failed start it ignores Record until restarted.
  await (await launch(port)).browser.close().catch(() => {});
  const control = async () => (await hud(port).catch(() => null)) || launch(port);
  let started = 0;

  return {
    /** Pick the window whose name contains `windowName` and start recording. */
    async start(windowName) {
      const { browser, page } = await control();
      try {
        // The source button opens the list of screens and windows.
        await page.locator('button[title="Record"]').waitFor({ timeout: 10000 });
        if (!(await page.locator('.source-selector-item').first().isVisible())) await page.locator('button[title]').first().click();
        const source = page.locator('.source-selector-item', { hasText: windowName }).first();
        await source.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
          throw new Error(`Recordly does not list a window called "${windowName}".`);
        });
        await source.click();
        // Recording the whole screen would show the desktop: refuse rather than record it.
        let picked = '';
        for (let i = 0; i < 25 && !picked?.includes(windowName); i++) {
          await sleep(200);
          picked = await page.locator('button[title]').first().getAttribute('title');
        }
        if (!picked?.includes(windowName)) throw new Error(`Recordly picked "${picked}", not the ${windowName} window.`);
        if (!(await page.locator('button[title="Record"]').isEnabled())) throw new Error('Recordly is not ready to record.');
        await sleep(800);
        // Recordly needs a moment to prepare the new source before Record takes.
        await sleep(1500);
        started = Date.now();
        // Recording once its Stop button shows (after Recordly's own countdown, if set).
        for (let attempt = 1; ; attempt++) {
          await page.locator('button[title="Record"]').click();
          const ok = await page.locator('button[aria-label="Stop"]').waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
          if (ok) break;
          if (attempt === 3) throw new Error('Recordly did not start recording after three presses of Record.');
        }
      } finally { await browser.close().catch(() => {}); }
    },
    /** Stop, and return the saved take's path once it is written (or null). */
    async stop() {
      const h = await hud(port);
      if (!h) return null;
      const { browser, page } = h;
      try {
        await page.locator('button[aria-label="Stop"]').click();
      } finally { await browser.close().catch(() => {}); }
      for (let i = 0; i < 60; i++) {
        const take = newestTake(recordingsDir(), started - 1000);
        if (take) { await sleep(1500); return take; }
        await sleep(1000);
      }
      return null;
    },
  };
}
