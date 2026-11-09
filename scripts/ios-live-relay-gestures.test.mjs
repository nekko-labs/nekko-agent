import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(`../apps/ios/${path}`, import.meta.url), 'utf8');
const live = read('UITests/LiveRelayTests.swift');
const pill = read('App/Views/AgentPill.swift');
const monitor = read('App/Views/ModeViews.swift');
const body = name => {
  const match = live.match(new RegExp(`func ${name}\\([^\\n]*\\n([\\s\\S]*?)^    }`, 'm'));
  assert.ok(match, `Missing ${name}`);
  return match[1];
};

// Source/geometry contracts only. These do not replace running XCUITest on iOS.
test('the live right-edge tuck crosses the drag threshold without opening the monitor', () => {
  const modes = body('testSimpleAndExpertModes');
  assert.match(modes, /let panel = app.buttons\["chat.monitor"\]/);
  assert.match(modes, /let tuckStart = panel.coordinate\(withNormalizedOffset: CGVector\(dx: 0.05, dy: 0.5\)\)/);
  assert.match(modes, /let tuckEnd = tuckStart.withOffset\(CGVector\(dx: window.frame.maxX - 1 - tuckStart.screenPoint.x, dy: 0\)\)/);
  assert.match(modes, /XCTAssertGreaterThan\(tuckEnd.screenPoint.x - tuckStart.screenPoint.x, 24,/);
  assert.match(modes, /tuckStart.press\(forDuration: 0.01, thenDragTo: tuckEnd, withVelocity: .fast, thenHoldForDuration: 0\)/);
  assert.match(modes, /XCTAssertTrue\(tab.waitForExistence\(timeout: 5\), "a swipe into the side tucks the pill away"\)/);
  assert.match(modes, /XCTAssertFalse\(app.buttons\["monitor.sheet"\].exists,/);
  assert.match(modes, /XCTAssertFalse\(panel.exists\)/);
  assert.match(modes, /tab.tap\(\)\s+XCTAssertTrue\(panel.waitForExistence\(timeout: 5\), "the tab brings the pill back"\)/);
});

test('inner-edge travel exceeds both production thresholds even with the narrowest gauge', () => {
  // Anchor the geometry to production, not to an invented minimum monitor width.
  assert.match(monitor, /\.frame\(width: 14, height: 14\)/);
  assert.match(pill, /\.padding\(\.horizontal, vertical \? 4 : 10\)/);
  assert.match(pill, /case .trailing: return CGPoint\(x: area.width - 12 - pill.width \/ 2, y: y\)/);
  assert.match(pill, /DragGesture\(minimumDistance: 16\)/);
  assert.match(pill, /case .trailing: return abs\(t.width\) > abs\(t.height\) && \(t.width > 24 \|\| predicted.width > 90\)/);
  for (const width of [320, 402, 768, 1024]) {
    for (const monitorWidth of [14, 20, 32, 44]) {
      const center = width - 12 - (monitorWidth + 2 * 4) / 2;
      const start = center + (0.05 - 0.5) * monitorWidth;
      const travel = width - 1 - start;
      assert.ok(travel > 24 && travel > 16, `${width}/${monitorWidth}: ${travel} points`);
    }
  }
  // The old center-to-99.5% path on the failing run's 402-point window can miss 24.
  assert.ok(402 * 0.995 - (402 - 12 - (14 + 2 * 4) / 2) < 24);
});

test('the follow-up uses one celebration helper which waits for auto-dismiss before any tap', () => {
  const followUp = body('testFollowUpInASubagent');
  assert.equal((followUp.match(/passCelebration\(app\)/g) ?? []).length, 1);
  assert.doesNotMatch(followUp, /pairSuccess.done/);
  assert.match(followUp, /passCelebration\(app\)\s+XCTAssertTrue\(waitOnline\(app, 30\)/);
  const celebration = body('passCelebration');
  assert.match(celebration, /if !waitGone\(done, 6\) \{\s+done.tap\(\)\s+_ = waitGone\(done, 5\)/);
  const success = read('App/Views/PairSuccessView.swift');
  assert.match(success, /guard !voiceOver else \{ return \}/);
  assert.match(success, /Task.sleep\(for: .seconds\(3.4\)\)/);
});
