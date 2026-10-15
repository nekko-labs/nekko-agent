import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { assertPortFree, selectOwner, selectPage, wrapperFailed } from './lib/browser-identity.mjs';

test('successful wrapper exit allows delayed child readiness; failures stop', () => {
  assert.equal(Boolean(wrapperFailed(null)), false);
  assert.equal(Boolean(wrapperFailed({ code: 0, signal: null })), false);
  assert.equal(Boolean(wrapperFailed({ code: 1, signal: null })), true);
  assert.equal(Boolean(wrapperFailed({ code: null, signal: 'SIGTERM' })), true);
});

test('page requires unique launch marker and exact local websocket port', () => {
  const marker = 'about:blank#unique';
  const page = { type: 'page', url: marker, webSocketDebuggerUrl: 'ws://127.0.0.1:9591/devtools/page/abc' };
  assert.equal(selectPage([page], marker, 9591), page);
  assert.throws(() => selectPage([{ ...page, url: 'about:blank' }], marker, 9591));
  assert.throws(() => selectPage([page], marker, 9598));
  assert.throws(() => selectPage([{ ...page, webSocketDebuggerUrl: 'ws://example.com:9591/devtools/page/abc' }], marker, 9591));
});

test('listener identity requires binary, exact profile, port and browser process', () => {
  const bin = 'C:/chrome.exe';
  const profile = 'C:/temp/fresh';
  const row = { ProcessId: 42, ExecutablePath: bin, CommandLine: `chrome --user-data-dir="${profile}" --remote-debugging-port=9591 --headless=new` };
  assert.equal(selectOwner([row], bin, profile, 9591), 42);
  for (const bad of [
    { ...row, ExecutablePath: 'C:/msedge.exe' },
    { ...row, CommandLine: row.CommandLine.replace('fresh', 'stale') },
    { ...row, CommandLine: row.CommandLine.replace('9591', '95910') },
    { ...row, CommandLine: row.CommandLine + ' --type=renderer' },
  ]) assert.throws(() => selectOwner([bad], bin, profile, 9591));
  assert.throws(() => selectOwner([row, { ...row, ProcessId: 43 }], bin, profile, 9591));
});

test('occupied port fails before launch without touching its listener', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(assertPortFree(server.address().port), { code: 'EADDRINUSE' });
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
