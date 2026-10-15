import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eligible, inside, measure } from './clean-builds.mjs';

test('cleanup protects tracked files, active ancestors and path boundaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'nekko-clean-'));
  try {
    const target = join(root, 'target'); mkdirSync(target);
    const file = join(target, 'source.rs'); writeFileSync(file, 'keep');
    assert.equal(eligible(target, [file], []), 'contains tracked files');
    assert.equal(eligible(target, [], [file]), 'active or protected path');
    assert.equal(eligible(target, [], [root]), 'active or protected path');
    assert.equal(eligible(target, [], [target + '-other']), null);
    assert.equal(measure(target).bytes, 4);
    assert.equal(inside(target, target + '-other'), false);
    writeFileSync(join(target, 'weights.safetensors'), 'model');
    assert.throws(() => measure(target), /possible model weights/);
  } finally { rmSync(root, { recursive: true }); }
});
