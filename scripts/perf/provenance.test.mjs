import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reportProvenance } from './lib/provenance.mjs';

test('measured checkout is not replaced by inherited workflow SHA', () => {
  const expected = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8', windowsHide: true,
  }).trim();
  assert.deepEqual(reportProvenance(process.cwd(), 'workflow-head'), {
    git: expected, workflowGit: 'workflow-head',
  });
});

test('source archive has unknown checkout, not a false head attribution', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'nekko-perf-provenance-'));
  try {
    assert.deepEqual(reportProvenance(dir, 'workflow-head'), {
      git: null, workflowGit: 'workflow-head',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
