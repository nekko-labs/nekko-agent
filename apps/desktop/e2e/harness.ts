import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { index } from './paths';

const electronPath: string = require('electron');

export interface Scenario {
  app: ElectronApplication;
  page: Page;
  /** Resize the window's content area (CSS px at 1x). */
  resize(width: number, height?: number): Promise<void>;
  /** Whether the window ever took OS focus; it must never. */
  tookFocus(): Promise<boolean>;
}

async function launch(name: string, width: number, height: number): Promise<{ scenario: Scenario; close(): Promise<void> }> {
  const profile = mkdtempSync(join(tmpdir(), 'nekko-e2e-'));
  const env: Record<string, string> = { ...process.env as Record<string, string>, NEKKO_E2E_PROFILE: profile, NEKKO_E2E_INDEX: index, NEKKO_E2E_SCENARIO: name, NEKKO_E2E_WIDTH: String(width), NEKKO_E2E_HEIGHT: String(height) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: electronPath, args: [join(__dirname, 'electron-main.cjs')], env });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.error(`[${name}] page error:`, error.message));
  await page.waitForFunction(() => !!(window as any).integration || !!document.body.dataset.e2eError);
  const error = await page.evaluate(() => document.body.dataset.e2eError);
  if (error) throw new Error(error);
  const scenario: Scenario = {
    app,
    page,
    resize: (w, h = height) => app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0]!.setContentSize(cw!, ch!), [w, h]),
    tookFocus: () => app.evaluate(({ BrowserWindow }) => (globalThis as any).__nekkoE2E.tookFocus || BrowserWindow.getAllWindows()[0]!.isFocused()),
  };
  const close = async () => {
    const child = app.process();
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise<void>((done) => child.once('exit', () => done()));
    await Promise.race([app.close().catch(() => {}), new Promise((done) => setTimeout(done, 10_000))]);
    // A plain kill can leave Electron's helper processes behind on Windows.
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
    // Chromium's helpers can hold profile files for a moment after the main process exits.
    rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  };
  return { scenario, close };
}

/**
 * A test bound to one scenario: one isolated Electron per spec file (worker
 * scope), shared by its tests, closed with its whole process tree afterwards.
 * `shot(name)` attaches a hidden-window capture to the report.
 */
export function scenarioTest(name: string, size = { width: 1200, height: 900 }) {
  return base.extend<{ shot: (label: string) => Promise<void> }, { scenario: Scenario }>({
    scenario: [async ({}, use) => {
      const { scenario, close } = await launch(name, size.width, size.height);
      try { await use(scenario); } finally { await close(); }
    }, { scope: 'worker' }],
    shot: async ({ scenario }, use, testInfo) => {
      await use(async (label) => {
        await scenario.page.waitForTimeout(250);
        const png = await scenario.app.evaluate(async ({ BrowserWindow }) =>
          (await BrowserWindow.getAllWindows()[0]!.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG().toString('base64'));
        await testInfo.attach(`${label}.png`, { body: Buffer.from(png, 'base64'), contentType: 'image/png' });
      });
      expect(await scenario.tookFocus(), 'the e2e window must never take focus').toBe(false);
    },
  });
}

export { expect };
