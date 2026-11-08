import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
// Execute the actual setup closure without starting a server, browser or daemon.
const start = source.indexOf('  const openChat = async ');
const end = source.indexOf('\n  /** Click a chat\'s sidebar card', start);
assert.ok(start > 0 && end > start, 'openChat remains a separately testable setup step');
const setup = source.slice(start, end);

function fixture(failure) {
  const calls = [];
  let selected = false;
  const cdp = {
    async evaluate(expression) {
      assert.equal(expression, 'View probe', 'only the shared View helper drives layout');
      calls.push('evaluate');
      return true;
    },
    async call(_fn, title) {
      assert.ok(selected, 'never click a card or inspect its transcript before View verification');
      assert.equal(title, 'Perf chat 00');
      calls.push('chat');
      return true;
    },
  };
  const openChat = runInNewContext(`${setup}\nopenChat;`, {
    cdp,
    chatTitle: () => 'Perf chat 00',
    lastMarker: () => '[perf-00-newest]',
    clickEl: async () => calls.push('nav'),
    waitFor: async () => calls.push('wait'),
    showAllCards: async () => { assert.ok(selected); calls.push('cards'); },
    sleep: async ms => { assert.equal(ms, 100); calls.push('settle'); },
    log: message => { assert.ok(selected); assert.match(message, /focus.*verified/); calls.push('log'); },
    selectWallView: async (run, mode, settle) => {
      assert.equal(mode, 'focus');
      calls.push('View');
      assert.equal(await run('View probe'), true, 'CDP evaluator forwards the shared helper expression');
      await settle();
      if (failure) throw failure;
      selected = true;
    },
  });
  return { openChat, calls };
}

test('perf openChat verifies Single agent through the shared View helper before selecting a card', async () => {
  assert.match(source, /import \{ selectWallView \} from '\.\.\/\.\.\/apps\/desktop\/scripts\/wall-view-navigation\.cjs'/);
  assert.doesNotMatch(setup, /wall-layout-segments|aria-pressed|Focused/);
  const f = fixture();
  await f.openChat(0);
  assert.deepEqual(f.calls, ['nav', 'wait', 'wait', 'View', 'evaluate', 'settle', 'log', 'cards', 'chat', 'wait', 'chat', 'chat']);
});

for (const message of ['Missing View toggle', 'View selection did not apply: focus', 'Escape did not dismiss View menu']) {
  test(`perf setup propagates ${message} before any chat measurement`, async () => {
    const error = Error(message);
    const f = fixture(error);
    await assert.rejects(f.openChat(0), actual => actual === error);
    assert.ok(!f.calls.includes('cards'));
    assert.ok(!f.calls.includes('chat'));
    assert.ok(!f.calls.includes('log'), 'a failed View selection is never reported as verified');
  });
}

test('View setup is not inserted into the measured sidebar switch', () => {
  const switchStart = source.indexOf('  const switchTo = async ');
  const switchEnd = source.indexOf('\n  };', switchStart);
  assert.ok(switchStart > end && switchEnd > switchStart);
  assert.doesNotMatch(source.slice(switchStart, switchEnd), /selectWallView|data-view-mode|wall-view-toggle/);
});
