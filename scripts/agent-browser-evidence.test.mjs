import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('evidence runner resolves the native binary at runtime, without serializing paths into source', () => {
  const source = readFileSync(new URL('./agent-browser-evidence.mjs', import.meta.url), 'utf8');
  const replacement = source.split('\n').find(line => line.includes("script.replace('driver: playwrightDriver'"));
  assert.ok(replacement.includes("createNativeDriver(join(process.cwd(), 'apps/desktop/resources/agent-browser'"));
  assert.ok(!replacement.includes('JSON.stringify'));
  assert.ok(!replacement.includes('${'));
  assert.ok(source.includes("{cwd:root,stdio:'inherit'"));
});
