import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { withPillHardwareFixture } from './pill-hardware-fixture.mjs';

for (const revision of ['9f8c5bb4e4d6c88b5a12385284c4de137cb203ba', '48af4fedaf442a63fc41a623e36587a1936c0c17']) {
  test(`evidence fixture overlays only refresh input on ${revision}`, () => {
    const source = execFileSync('git', ['show', `${revision}:apps/ios/Protocol/Sources/NekkoKit/HardwareMonitorModel.swift`], { encoding: 'utf8' });
    const patched = withPillHardwareFixture(source);
    assert.ok(patched.includes('SystemStats.from(["cpuPct": 12'));
    assert.ok(patched.includes('GpuStats.from(["totalMB": 8192'));
    const start = patched.indexOf('        #if DEBUG\n        if ProcessInfo.processInfo.arguments.contains("-uiTestPillHardware")');
    const end = patched.indexOf('        #endif\n', start) + '        #endif\n'.length;
    assert.equal(patched.slice(0, start) + patched.slice(end), source);
    assert.throws(() => withPillHardwareFixture(patched));
  });
}

test('velocity diagnostic preserves preconditions and all tuck assertions', () => {
  const ui = fs.readFileSync('apps/ios/UITests/PillVelocityDiagnosticTests.swift', 'utf8');
  for (const marker of ['-uiTestPillHardware', 'the gauges stack', 'the pill docks on the right', 'a swipe into the side tucks the pill away', 'a tuck swipe does not open monitor details', 'the tab restores the pill', 'XCUIGestureVelocity(rawValue: 200)']) assert.ok(ui.includes(marker), marker);
});
