const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('matched evidence overlays fixture code, never production scrolling or notice', () => {
  const workflow = read('../.github/workflows/ios-streaming-evidence.yml');
  const copies = workflow.split('\n').filter((line) => line.trim().startsWith('cp '));
  assert.equal(copies.length, 3);
  for (const line of copies) assert.match(line, /ChatRefreshFixture|StreamingGeometryProbe|StreamingStabilityTests/);
  assert.match(workflow, /revision: \[before, after\]/);
  assert.match(workflow, /matrix\.device/);
  assert.match(workflow, /SimRuntime\.iOS-27-0/);
  assert.match(workflow, /recordVideo/);
  assert.match(workflow, /ios-streaming-\$\{\{ matrix.revision \}\}-\$\{\{ matrix.device \}\}/);
});

test('stream fixture and production app remain separated', () => {
  const fixture = read('ios/App/Views/ChatRefreshFixture.swift');
  assert.ok(fixture.startsWith('#if DEBUG'));
  assert.match(fixture, /contains\("-refreshStream"\)/);
  assert.match(fixture, /Events.agentEvent/);
  assert.match(fixture, /StreamingGeometryProbe/);
  const app = read('ios/App/NekkoApp.swift');
  assert.match(app, /let flags = \[[^\]]*"-uiTestChatRefresh"/);
});

test('native journey has measured regression and follow-intent assertions', () => {
  const tests = read('ios/UITests/StreamingStabilityTests.swift');
  assert.match(tests, /XCTAssertNotNil\(regression/);
  assert.match(tests, /XCTAssertLessThanOrEqual\(regression, 1/);
  assert.match(tests, /transcript.swipeDown\(\)/);
  assert.match(tests, /jump.tap\(\)/);
  assert.match(tests, /XCTAssertEqual\(note.frame.height/);
});

test('reconnect punctuation changes opacity, never its text or width', () => {
  const notice = read('ios/App/Views/ReconnectingNotice.swift');
  assert.match(notice, /ForEach\(0..<3/);
  assert.match(notice, /Text\("\."\).opacity/);
  assert.match(notice, /paused: reduceMotion \|\| phase != .active/);
  assert.match(notice, /accessibilityLabel\("\\\(name\) is reconnecting\.\.\."\)/);
  assert.match(notice, /Draft your message now and it will send when \\\(name\) reconnects/);
});

test('measured growth targets the content edge, not a lazy sentinel', () => {
  const follow = read('ios/App/Views/TranscriptFollow.swift');
  assert.match(follow, /ScrollPosition\(edge: \.bottom\)/);
  assert.match(follow, /position\.scrollTo\(edge: \.bottom\)/);
  assert.doesNotMatch(follow, /proxy\.scrollTo|follow\(\)/);
  const tests = read('ios/UITests/StreamingStabilityTests.swift');
  assert.match(tests, /XCTAssertEqual\(title\.label, "Gomi is reconnecting\.\.\."\)/);
});

test('iOS 18 structural growth does not race content-edge following with sentinel settling', () => {
  const chat = read('ios/App/Views/ChatView.swift');
  const handler = chat.split('.onChange(of: chat.blocksRevision)')[1].split('.onAppear')[0];
  assert.match(handler, /if #unavailable\(iOS 18\.0\)/);
  assert.doesNotMatch(handler, /if #available/);
});
