const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Library sandbox escapes code literals and preserves button text', () => {
  const source = fs.readFileSync(path.join(__dirname, 'library-intro-sandbox.cjs'), 'utf8');
  const helper = source.split('\n').find(line => line.startsWith('const js = '));
  assert.ok(helper);
  const js = vm.runInNewContext(`${helper}\njs`);
  for (const text of ['Library guide', '</script><script>alert(1)</script>', '"; throw Error("injection"); //', 'line\u2028paragraph\u2029', '\\backslash\n\t\0']) {
    const literal = js(text);
    assert.doesNotMatch(literal, /[<>/\u2028\u2029]/);
    assert.equal(vm.runInNewContext(literal), text);
  }
  assert.ok(source.includes('${js(text)}'));
  assert.ok(!source.includes('${JSON.stringify(text)}'));
});
