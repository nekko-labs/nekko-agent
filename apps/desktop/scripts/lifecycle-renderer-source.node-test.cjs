const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { sourceLiteral, buttonSource, keySource } = require('./lifecycle-renderer-source.cjs');
const hostile = '</script><script>globalThis.injected=true</script>\"\'`\\\n\r\t\0\b\f\u2028\u2029${globalThis.injected=true}';

test('JSON literals round-trip without HTML delimiters or raw line separators', () => {
  for (const value of [hostile, { text: hostile, nested: [null, true, 12] }, 'Cancel', 'light', 'settings']) {
    const source = sourceLiteral(value);
    assert.doesNotMatch(source, /[<>\u2028\u2029]/);
    assert.equal(JSON.stringify(vm.runInNewContext(`(${source})`)), JSON.stringify(value));
  }
  assert.throws(() => sourceLiteral(undefined), TypeError);
});

test('button labels remain data, with exact matching and safe missing-label errors', () => {
  for (const text of [hostile, 'Cancel', 'Delete chat']) {
    let clicks = 0;
    const context = { document: { querySelectorAll: selector => {
      assert.equal(selector, 'button');
      return [{ textContent: 'decoy', click: () => assert.fail('Wrong button') }, { textContent: text, click: () => clicks++ }];
    } } };
    const source = buttonSource(text);
    assert.doesNotMatch(source, /<\/script|[\u2028\u2029]/i);
    vm.runInNewContext(source, context);
    assert.equal(clicks, 1);
    assert.equal(context.injected, undefined);
    assert.throws(() => vm.runInNewContext(source, { document: { querySelectorAll: () => [] } }), e => e.message === 'Missing button ' + text);
  }
});

test('aria labels never enter selector syntax; keys preserve event payload', () => {
  let focused = 0, event;
  const context = {
    document: { querySelectorAll: selector => {
      assert.equal(selector, '[aria-label]');
      return [{ getAttribute: name => { assert.equal(name, 'aria-label'); return hostile; }, focus: () => focused++ }];
    } },
    KeyboardEvent: function (type, opts) { this.type = type; Object.assign(this, opts); },
    window: { dispatchEvent: e => { event = e; } },
  };
  vm.runInNewContext(keySource(hostile, hostile), context);
  assert.equal(focused, 1);
  assert.equal(event.type, 'keydown');
  assert.equal(event.key, hostile);
  for (const flag of ['ctrlKey', 'shiftKey', 'bubbles', 'cancelable']) assert.equal(event[flag], true);
  assert.equal(context.injected, undefined);
});
