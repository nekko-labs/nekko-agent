import assert from 'node:assert/strict';
import test from 'node:test';
import { patchSecurity, plan, readableName, testArgs, DEFAULT_RUNTIME } from './ios-evidence-local.mjs';

test('exported attachments get readable, unique names', () => {
  const taken = new Set();
  assert.equal(readableName('card-details-menu_0_DEADDC03-9A36-4CF6-A006-E3F85B7C6CF2.png', taken), 'card-details-menu.png');
  assert.equal(readableName('card-details-menu_1_0A7E37B8-E186-4B9D-9710-EBB69548520F.png', taken), 'card-details-menu-2.png');
  assert.equal(readableName('tree_0_EA8B8712-8FA5-4DC8-B836-30A14FC471ED.txt', taken), 'tree.txt');
  assert.equal(readableName('Screen Shot.png', taken), 'Screen-Shot.png');
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('mode preset overlays the test file and its fixtures from the harness', () => {
  const opts = plan(['--baseline', A, '--source', B, '--test-file', 'apps/ios/UITests/SecurityComparisonTests.swift', '--only-testing', 'NekkoNativeUITests/SecurityComparisonTests']);
  assert.equal(opts.preset, 'mode');
  assert.equal(opts.harness, B, 'the harness defaults to the source commit, as in the workflow');
  assert.equal(opts.runtime, DEFAULT_RUNTIME);
  assert.deepEqual(opts.overlays, ['apps/ios/UITests/SecurityComparisonTests.swift', 'apps/ios/App/Views/SecurityEvidenceFixture.swift']);
  assert.equal(opts.patchSecurity, true);
  assert.equal(opts.baselineEnv, 'TEST_RUNNER_NEKKO_EVIDENCE_BASELINE');
  assert.deepEqual(opts.revisions, ['before', 'after']);
  const quiet = plan(['--baseline', A, '--source', B, '--harness', C, '--test-file', 'apps/ios/UITests/QuietTranscriptTests.swift', '--only-testing', 'X/Y']);
  assert.equal(quiet.video, 'quiet-transcript.mp4');
  assert.equal(quiet.harness, C);
});

test('groups and computer-settings presets match their workflows', () => {
  const groups = plan(['--preset', 'groups', '--baseline', A, '--source', B]);
  assert.deepEqual(testArgs(groups, 'before'), ['-only-testing:NekkoNativeUITests/GroupEvidenceTests', '-only-testing:NekkoNativeUITests/PurposeGroupsTests']);
  assert.deepEqual(testArgs(groups, 'after').at(-1), '-only-testing:NekkoNativeTests/ChatGroupPrefsTests');
  assert.equal(groups.prepare.args('before')[0], '--before');
  assert.equal(groups.video, 'groups.mp4');
  const computer = plan(['--preset', 'computer-settings', '--baseline', A, '--source', B, '--only', 'after']);
  assert.deepEqual(computer.revisions, ['after']);
  assert.equal(computer.prepare.only, 'before', 'only the baseline gets the launch route inserted');
  assert.deepEqual(testArgs(computer, 'after'), ['-only-testing:NekkoNativeUITests/ComputerSettingsEvidenceUITests', '-parallel-testing-enabled', 'NO']);
});

test('refuses moving refs, paths outside apps/ios and unknown flags', () => {
  assert.throws(() => plan(['--baseline', 'main', '--source', B, '--preset', 'groups']), /full 40-character/);
  assert.throws(() => plan(['--baseline', A, '--source', B, '--harness', 'HEAD', '--preset', 'groups']), /full commit SHA/);
  assert.throws(() => plan(['--baseline', A, '--source', B, '--preset', 'custom', '--only-testing', 'X', '--overlay', '../secrets']), /outside apps\/ios/);
  assert.throws(() => plan(['--baseline', A, '--source', B, '--preset', 'custom', '--only-testing', 'X', '--overlay', 'apps/ios/../../x']), /outside apps\/ios/);
  assert.throws(() => plan(['--baseline', A, '--source', B, '--test-file', 'apps/ios/UITests/X.swift']), /--only-testing/);
  assert.throws(() => plan(['--baseline', A, '--source', B, '--preset', 'groups', '--label', 'a/b']), /--label/);
  assert.throws(() => plan(['--baseline', A, '--source', B, '--bogus']), /unknown flag/);
  assert.throws(() => plan(['--baseline']), /needs a value/);
});

test('security patch adds the fixture route once and fails on moved anchors', () => {
  const app = 'let flags = ["-uiTestChatRefresh", "-x"]\n        if ProcessInfo.processInfo.arguments.contains("-uiTestVoiceConversation") { V() }';
  const once = patchSecurity(app);
  assert.match(once, /"-uiTestSecurityEvidence", "-uiTestChatRefresh"/);
  assert.match(once, /SecurityEvidenceFixture\(\) \} else\n {8}if/);
  assert.equal(patchSecurity(once), once);
  assert.throws(() => patchSecurity('nothing here'), /anchors/);
});
