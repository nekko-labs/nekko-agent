import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { traceEdits, traceHelper, withPillGestureTrace } from './pill-gesture-trace.mjs';

for (const revision of ['9f8c5bb4e4d6c88b5a12385284c4de137cb203ba', '37839887a05d431c5dd889034c0658f2b7f26cb9']) {
  test(`callback trace is reversible with no gesture action changes on ${revision}`, () => {
    const source = execFileSync('git', ['show', `${revision}:apps/ios/App/Views/AgentPill.swift`], { encoding: 'utf8' });
    let patched = withPillGestureTrace(source);
    assert.ok(patched.includes('NEKKO_PILL_TRACE \\(event)'));
    assert.ok(patched.includes('tuck.changed translation=\\(v.translation)'));
    assert.ok(patched.includes('tuck.ended translation=\\(v.translation)'));
    assert.ok(patched.includes('#if DEBUG\n    guard ProcessInfo.processInfo.arguments.contains("-uiTestPillHardware")'));
    assert.throws(() => withPillGestureTrace(patched));
    assert.ok(patched.endsWith(traceHelper));
    patched = patched.slice(0, -traceHelper.length);
    for (const [before, after] of traceEdits.toReversed()) patched = patched.replace(after, before);
    assert.equal(patched, source);
  });
}
test('callback experiment retains exact failed test and captures native logs', () => {
  const file = 'apps/ios/UITests/PillVelocityDiagnosticTests.swift';
  assert.equal(fs.readFileSync(file, 'utf8'), execFileSync('git', ['show', `f4244ac264c111538af01aee4ee5ab0e847a2c0b:${file}`], { encoding: 'utf8' }));
  const workflow = fs.readFileSync('.github/workflows/native-mode-evidence.yml', 'utf8');
  assert.ok(workflow.includes('node .evidence-harness/apps/ios/scripts/pill-gesture-trace.mjs'));
  assert.ok(workflow.includes('log stream --level debug --style compact'));
  assert.ok(workflow.includes('evidence/pill-gesture.log'));
  assert.ok(workflow.includes('kill "$TRACE"'));
});
