// The desktop type-checks against @nekko-agent/shared's source in this tree (#1153).
// Through the package's built dist it could check against stale types, and a
// worktree without its own node_modules would check against the primary
// checkout's dist instead of its own source.
//
// TypeScript 7 has no JavaScript API, so this asks the compiler itself which
// files the desktop's program holds (`--listFilesOnly`, no type check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

test('the desktop type-checks against this tree\'s shared source, never a built dist', () => {
  const files = execFileSync(process.execPath, [tsc, '-p', path.join(repo, 'apps/desktop/tsconfig.json'), '--listFilesOnly'], { encoding: 'utf8', windowsHide: true })
    .split(/\r?\n/).filter(Boolean).map(f => path.resolve(f));
  assert.ok(files.includes(path.join(repo, 'packages/shared/src/index.ts')), 'packages/shared/src/index.ts is in the program');
  const dist = files.filter(f => f.includes(`${path.sep}shared${path.sep}dist${path.sep}`));
  assert.deepEqual(dist, [], 'no built shared dist is in the program');
});

test('the source condition comes before types, so TypeScript picks it', () => {
  const exportsDot = require(path.join(repo, 'packages/shared/package.json')).exports['.'];
  assert.deepEqual(Object.keys(exportsDot).slice(0, 2), ['source', 'types']);
});
