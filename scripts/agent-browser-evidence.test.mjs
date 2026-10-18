import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('evidence source replacements preserve dollar sequences in local paths', () => {
  const source = readFileSync(new URL('./agent-browser-evidence.mjs', import.meta.url), 'utf8');
  const replacement = source.split('\n').find(line => line.includes("script.replace('driver: playwrightDriver'"));
  assert.ok(replacement.includes(', () => `'));
  for (const path of ['C:/fixture/$&/agent-browser.exe', "C:/fixture/$`/agent-browser.exe", "C:/fixture/$'/agent-browser.exe"]) {
    const literal = JSON.stringify(path);
    const actual = 'driver: playwrightDriver'.replace('driver: playwrightDriver', () => `driver: () => createNativeDriver(${literal})`);
    assert.equal(actual, `driver: () => createNativeDriver(${literal})`);
  }
});
