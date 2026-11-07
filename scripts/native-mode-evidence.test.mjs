import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/native-mode-evidence.yml', import.meta.url), 'utf8');

test('native evidence exposes optional runtime pin for dispatch and reusable callers', () => {
  assert.equal((workflow.match(/^      ios_runtime:$/gm) ?? []).length, 2);
  assert.match(workflow, /IOS_RUNTIME: \$\{\{ inputs\.ios_runtime \}\}/);
  assert.match(workflow, /requested = ENV\.fetch\("IOS_RUNTIME", ""\)/);
  assert.match(workflow, /requested\.empty\? \|\| r\["identifier"\] == requested/);
});

test('native evidence preserves available iOS selection and rejects a missing pin before creation', () => {
  assert.match(workflow, /r\["isAvailable"\] && r\["identifier"\]\.include\?\("iOS"\)/);
  const read = workflow.indexOf('read -r RUNTIME TYPE');
  const guard = workflow.indexOf('test -n "$RUNTIME" && test -n "$TYPE"');
  const create = workflow.indexOf('DEVICE=$(xcrun simctl create');
  assert.ok(read > 0 && guard > read && create > guard);
  assert.match(workflow.slice(0, read), /set -euo pipefail/);
  assert.match(workflow, /echo "device=\$TYPE runtime=\$RUNTIME" >> evidence\/revisions\.txt/);
});
