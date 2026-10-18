import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { assertPortFree, findBrowser, launchBrowser, selectPage } from './lib/browser.mjs';

test('a page counts only with this launch marker and a local websocket on our port', () => {
  const marker = 'data:text/html,nekko-perf-unique';
  const page = { type: 'page', url: marker, webSocketDebuggerUrl: 'ws://127.0.0.1:9591/devtools/page/abc' };
  assert.equal(selectPage([page], marker, 9591), page);
  assert.equal(selectPage([{ ...page, url: 'about:blank' }], marker, 9591), null);
  assert.equal(selectPage([{ ...page, type: 'service_worker' }], marker, 9591), null);
  assert.equal(selectPage([page], marker, 9598), null);
  assert.equal(selectPage([{ ...page, webSocketDebuggerUrl: 'ws://example.com:9591/devtools/page/abc' }], marker, 9591), null);
  assert.equal(selectPage([{ ...page, webSocketDebuggerUrl: 'not a url' }], marker, 9591), null);
  assert.equal(selectPage(null, marker, 9591), null);
});

test('an occupied port fails before launch and leaves its listener alone', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(assertPortFree(port), { code: 'EADDRINUSE' });
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assertPortFree(port);
});

let hasBrowser = false;
try { findBrowser(); hasBrowser = true; } catch { /* no Chromium on this machine */ }

test('a real launch finds its own page and close() ends the tree and profile', { skip: !hasBrowser && 'no Chromium installed' }, async () => {
  const port = 9300 + Math.floor(Math.random() * 400);
  const browser = await launchBrowser({ port, width: 400, height: 300 });
  const profile = (() => {
    if (process.platform !== 'win32') return null;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${browser.proc.pid}').CommandLine`], { windowsHide: true }).toString();
    return /--user-data-dir=(\S+)/.exec(out)?.[1] ?? null;
  })();
  try {
    assert.match(browser.wsUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${port}/devtools/page/`));
  } finally {
    await browser.close();
  }
  if (process.platform === 'win32') {
    const left = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*remote-debugging-' + 'port=${port}*') }).Count`], { windowsHide: true }).toString().trim();
    assert.equal(left, '0');
    if (profile) assert.equal(existsSync(profile), false);
  }
});
