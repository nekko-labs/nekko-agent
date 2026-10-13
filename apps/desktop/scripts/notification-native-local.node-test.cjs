const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertLocalOptIn } = require('./notification-native-local.cjs');
test('Local launcher requires exact explicit permission and Windows', () => {
  for (const args of [[], ['--native-ci'], ['--allow-local-notification-test', '--extra']]) assert.throws(() => assertLocalOptIn(args, 'win32'));
  assert.throws(() => assertLocalOptIn(['--allow-local-notification-test'], 'linux'));
  assert.doesNotThrow(() => assertLocalOptIn(['--allow-local-notification-test'], 'win32'));
});
test('Manual local fixture has one production-adapter post and no CI helper or OS input', () => {
  const source = fs.readFileSync(path.join(__dirname, 'notification-native-local-sandbox.cjs'), 'utf8');
  assert.equal((source.match(/poster\.post\(/g) || []).length, 1);
  assert.match(source, /createNativeNotificationPoster/);
  assert.match(source, /90000/);
  assert.match(source, /20000/);
  assert.match(source, /capturePage/);
  assert.doesNotMatch(source, /notification-native-ci|powershell|SendKeys|InvokePattern|spawn\(/);
});
