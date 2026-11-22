const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'tooltips-sandbox.cjs'), 'utf8');
const helper = source.split('\n').find(line => line.startsWith('const js = '));
assert.ok(helper);
const js = vm.runInNewContext(`${helper}\njs`);

test('tooltip selector stays data when spliced into evaluated code', () => {
  const selector = `#tip'); globalThis.injected = true; ('</script>\u2028\u2029`;
  const literal = js(selector);
  assert.doesNotMatch(literal, /[<>/\u2028\u2029]/);

  let captured;
  const context = {
    document: {
      querySelector(value) {
        captured = value;
        return null;
      },
    },
  };
  vm.runInNewContext(`document.querySelector(${literal})`, context);

  assert.equal(captured, selector);
  assert.equal(context.injected, undefined);
  assert.ok(source.includes('document.querySelector(${js(selector)})'));
  assert.ok(!source.includes('document.querySelector(${JSON.stringify(selector)})'));
});
