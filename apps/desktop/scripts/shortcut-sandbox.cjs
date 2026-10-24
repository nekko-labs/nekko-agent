const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_SHORTCUT_OUT;
if (!out) throw Error('Use shortcut-integration.cjs');
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
const report = { checks: [], errors: [], blockedRequests: [], hidden: true };

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => {
    const cancel = !/^(file:|data:|blob:)/.test(r.url);
    if (cancel) report.blockedRequests.push(r.url);
    done({ cancel });
  });
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s);
  const poll = async (label, predicate) => {
    const deadline = Date.now() + 5000;
    let state;
    while (Date.now() < deadline) {
      state = await run('window.shortcutTest?.snapshot()');
      if (state) assert.deepEqual(state.unexpectedCalls, [], label + ' unsupported bridge calls');
      if (state && predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(label + ' timed out: ' + JSON.stringify(state));
  };
  const reset = async onboarding => {
    const generation = await run('shortcutTest.reset(' + onboarding + ')');
    await poll('committed reset', s => s.ready && s.committedGeneration === generation && s.onboardingOpen === onboarding && s.calls.length === 0);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await poll('App effect readiness', s => s.ready && s.shortcutHandlerInstalled);
    assert.equal(await run('(async () => { await nekko.updateSettings({ fixturePersistence: 123 }); return (await nekko.getSettings()).fixturePersistence; })()'), 123);
    for (const modifier of ['ctrlKey', 'metaKey']) {
      const chords = [
        ['t', false, 'agent'], ['T', false, 'agent'], ['n', false, 'agent'], ['N', false, 'agent'],
        ['t', true, 'terminal'], ['T', true, 'terminal'], ['`', false, 'terminal'], ['`', true, 'terminal'], ['~', true, 'terminal'], ['j', false, 'terminal'], ['J', false, 'terminal'],
      ];
      for (const [key, shiftKey, kind] of chords) {
        for (const mode of ['normal', 'alt', 'onboarding']) {
          const name = `${modifier} ${shiftKey ? 'Shift+' : ''}${key} ${mode}`;
          await reset(mode === 'onboarding');
          const event = await run(`shortcutTest.dispatch(${JSON.stringify({ key, shiftKey, [modifier]: true, altKey: mode === 'alt' })})`);
          const handled = mode === 'normal';
          // A new agent is focused on the wall; a new terminal opens as a workspace.
          const state = await poll(name + ' completion', s => !handled || (s.calls.length === 1 && s.view === 'command' && (kind === 'agent' ? s.focusRequest : s.activeWorkspaceId && s.workspaces.length > 0)));
          assert.equal(event.defaultPrevented, handled, name + ' preventDefault');
          assert.equal(event.dispatched, !handled, name + ' dispatch result');
          assert.equal(state.calls.length, handled ? 1 : 0, name + ' host calls');
          if (handled) {
            assert.equal(state.calls[0].method, kind === 'agent' ? 'createSession' : 'createTerminal', name);
            assert.equal(state.view, 'command', name + ' real store view');
            const id = kind === 'agent' ? state.sessions[0]?.id : state.terminals[0]?.id;
            assert.ok(id, name + ' real store record');
            if (kind === 'agent') {
              assert.equal(state.focusRequest?.sessionId, id, name + ' focused on the wall');
              assert.equal(state.activeSessionId, id);
              assert.equal(state.calls[0].workspaceId, 'synthetic-project');
            } else {
              assert.ok(JSON.stringify(state.workspaces).includes(`"refId":"${id}"`), name + ' real pane');
              assert.equal(state.calls[0].options.workspaceId, 'synthetic-project');
            }
          } else assert.equal(state.workspaces.length, 0, name + ' no pane');
          report.checks.push({ name, passed: true, event, state });
        }
      }
    }
    for (const init of [{ key: 't' }, { key: 'T', shiftKey: true }, { key: 'n', ctrlKey: true, shiftKey: true }, { key: 'x', metaKey: true }]) {
      await reset(false);
      const event = await run(`shortcutTest.dispatch(${JSON.stringify(init)})`);
      assert.equal(event.defaultPrevented, false); assert.equal((await run('shortcutTest.snapshot()')).calls.length, 0);
      report.checks.push({ name: `unmatched ${JSON.stringify(init)}`, passed: true });
    }
    for (const tag of ['input', 'textarea', 'div']) {
      await reset(false);
      const event = await run('shortcutTest.dispatch(' + JSON.stringify({ key: 't', ctrlKey: true }) + ', ' + JSON.stringify(tag) + ')');
      const state = await poll('focused ' + tag, s => s.calls.length === 1 && s.view === 'command' && s.focusRequest);
      assert.equal(event.defaultPrevented, true);
      assert.equal(state.calls.length, 1);
      assert.equal(state.calls[0].method, 'createSession');
      report.checks.push({ name: 'focused DOM ' + tag, passed: true });
    }
    assert.deepEqual((await run('shortcutTest.snapshot()')).unexpectedCalls, []);
    assert.equal(win.isVisible(), false); assert.equal(win.isFocusable(), false);
    assert.deepEqual(report.errors, []);
    console.log(`PASS: ${report.checks.length} App KeyboardEvent-to-real-store cases; hidden, isolated, network blocked.`);
  } catch (e) { report.errors.push(e.stack); console.error(e); process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    win.destroy(); app.quit();
  }
});
