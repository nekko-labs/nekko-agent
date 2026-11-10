import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const script = path.join(root, 'apps/ios/scripts/group-evidence.mjs');

for (const [revision, persistence] of [['before', true], ['after', true], ['before', false], ['before', 'partial']]) {
  test(`group evidence overlays ${revision} (persistence=${persistence}) without replacing production disclosure`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nekko-group-evidence-'));
    try {
      for (const file of ['App/NekkoApp.swift', 'App/Views/ChatsView.swift', 'App/Platform/Prefs.swift', 'scripts/GroupEvidenceTests.swift']) {
        const target = path.join(dir, 'apps/ios', file.replace('scripts/', 'UITests/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(root, 'apps/ios', file), target);
      }
      if (persistence === 'partial') {
        const prefs = path.join(dir, 'apps/ios/App/Platform/Prefs.swift');
        fs.writeFileSync(prefs, fs.readFileSync(prefs, 'utf8').replace(
          'openedChatGroups = Set(d.stringArray(forKey: "openedChatGroups") ?? [])', 'openedChatGroups = []'));
        assert.throws(() => execFileSync(process.execPath, [script, `--${revision}`], { cwd: dir, stdio: 'pipe' }),
          /Unrecognized group persistence/);
        return;
      }
      if (!persistence) {
        const prefs = path.join(dir, 'apps/ios/App/Platform/Prefs.swift');
        const source = fs.readFileSync(prefs, 'utf8')
          .replace('d.set(openedChatGroups.sorted(), forKey: "openedChatGroups")', '')
          .replace('openedChatGroups = Set(d.stringArray(forKey: "openedChatGroups") ?? [])', 'openedChatGroups = []');
        fs.writeFileSync(prefs, source);
      }
      execFileSync(process.execPath, [script, `--${revision}`], { cwd: dir });
      const read = file => fs.readFileSync(path.join(dir, 'apps/ios', file), 'utf8');
      const view = read('App/Views/ChatsView.swift');
      assert.ok(view.includes('private var opened: Set<String> { prefs.openedChatGroups }'));
      assert.ok(view.includes('withAnimation { flip(&prefs.openedChatGroups, g.key) }'));
      assert.ok(view.includes('guard query.isEmpty else { return }'));
      assert.ok(view.includes('Menu("Card details")'));
      assert.ok(read('App/NekkoApp.swift').includes('let flags = ["-uiTestGroupList", '));
      const prefs = read('App/Platform/Prefs.swift');
      assert.ok(prefs.includes('!ProcessInfo.processInfo.arguments.contains("-uiTestKeepGroups")'));
      assert.equal(prefs.includes('openedChatGroups = Set(d.stringArray(forKey: "openedChatGroups") ?? [])'), persistence);
      const ui = read('UITests/GroupEvidenceTests.swift');
      assert.ok(ui.includes(`let remembersGroups = ${persistence}`));
      assert.ok(ui.includes(`let after = ${revision === 'after'}`));
      for (const line of [
        'XCTAssertEqual(building.value as? String, remembersGroups ? "Expanded" : "Collapsed")',
        'XCTAssertEqual(watching.value as? String, remembersGroups ? "Expanded" : "Collapsed")',
        'if remembersGroups { building.tap() }',
      ]) assert.ok(ui.includes(line), `preserve assertion: ${line}`);
      assert.ok(ui.includes('"groups-after-relaunch"'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('native evidence always supplies UI tests in a nonempty Bash array', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ios-group-evidence.yml'), 'utf8');
  const initial = workflow.match(/FOCUSED=\(([^\n]*)\)/)?.[1].trim().split(/\s+/);
  assert.deepEqual(initial, [
    '-only-testing:NekkoNativeUITests/GroupEvidenceTests',
    '-only-testing:NekkoNativeUITests/PurposeGroupsTests',
  ]);
  assert.match(workflow, /if \[.*matrix\.revision.*= after \]; then\s+FOCUSED\+=\(-only-testing:NekkoNativeTests\/ChatGroupPrefsTests\)/);
  assert.equal((workflow.match(/-only-testing:NekkoNativeUITests\/GroupEvidenceTests/g) ?? []).length, 1);
  assert.equal((workflow.match(/-only-testing:NekkoNativeUITests\/PurposeGroupsTests/g) ?? []).length, 1);
});

// The native menu replaces the old Form, but the independent field and persistence
// checks must still assert the real spoken row, not nonexistent child labels.
test('card details exercises each native menu toggle without changing other fields', () => {
  const ui = fs.readFileSync(path.join(root, 'apps/ios/scripts/GroupEvidenceTests.swift'), 'utf8');
  for (const line of [
    'marker: "Pull request 42, open"',
    'for field in fields { XCTAssertTrue(row(app).label.contains(field.marker), field.marker) }',
    'let control = app.buttons[fields[index].setting].firstMatch',
    'XCTAssertTrue(control.isHittable, fields[index].setting)',
    'control.tap()',
    'control.waitForExistence(timeout: 3)',
    'closeCardViewOptions(app, control: control)',
    'other > index',
    '"-uiTestKeepCardDetails"',
    'XCTAssertFalse(row(app).label.contains(field.marker)',
  ]) assert.ok(ui.includes(line), line);
  assert.ok(!ui.includes('control.switches.firstMatch'));
});

test('view menu retains key paths, stable selectors and in-place toggle actions', () => {
  const view = fs.readFileSync(path.join(root, 'apps/ios/App/Views/ChatsView.swift'), 'utf8');
  assert.ok(!view.includes('bind(.'));
  assert.ok(!view.includes('id: .self'));
  for (const field of ['showModel', 'showContext', 'showPullRequests', 'showUpdated']) {
    assert.ok(view.includes('accessibilityIdentifier("chats.view.' + field + '")'));
  }
  assert.ok(!view.includes('.popover(isPresented: $viewOptionsOpen)'));
  assert.ok(view.includes('.menuActionDismissBehavior(.disabled)'));
});

test('group parity drives Show submenu and checks Reset only after a change', () => {
  const ui = fs.readFileSync(path.join(root, 'apps/ios/UITests/PhoneParityTests.swift'), 'utf8');
  assert.ok(ui.includes('guard openViewOptionsSubmenu("Show", showing: always, in: app) else { return }'));
  assert.ok(ui.includes('XCTAssertFalse(app.buttons["Reset to defaults"].exists'));
  assert.ok(ui.includes('XCTAssertTrue(app.buttons["Reset to defaults"].waitForExistence(timeout: 5)'));
  assert.ok(ui.includes('XCTAssertTrue(app.staticTexts["Building"].waitForExistence(timeout: 3))'));
});
