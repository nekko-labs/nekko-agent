import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/native-mode-evidence.yml', import.meta.url), 'utf8');
const androidScript = readFileSync(new URL('../apps/android/scripts/mode-evidence.sh', import.meta.url), 'utf8');
const voiceFixture = readFileSync(new URL('../apps/android/app/src/androidTest/java/com/nekko/android/VoiceIntegrationEvidenceTest.kt', import.meta.url), 'utf8');

test('Android voice baseline assertions and media use the runner revision argument', () => {
  assert.match(androidScript, /-e nekkoRevision "\$revision"/);
  assert.match(voiceFixture, /getString\("nekkoRevision"\) == "before"/);
  assert.match(voiceFixture, /getString\("nekkoRevision", "after"\)/);
  assert.doesNotMatch(voiceFixture, /nekkoModeRevision/);
  assert.match(androidScript, /\$out\/\$revision-phone-voice-motion\.mp4/);
  assert.match(androidScript, /\[\[ "\$revision" == "before" \|\| "\$revision" == "after" \]\]/);
});

test('Android voice fixture receives IME insets using the production window contract', () => {
  const setup = voiceFixture.indexOf('compose.activity.enableEdgeToEdge()');
  assert.ok(setup >= 0 && setup < voiceFixture.indexOf('compose.setContent'));
  assert.match(voiceFixture, /setSoftInputMode\(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE\)/);
  assert.match(voiceFixture, /WindowInsetsCompat.Type.ime\(\)/);
  assert.match(voiceFixture, /Espresso.closeSoftKeyboard\(\)/);
});

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
