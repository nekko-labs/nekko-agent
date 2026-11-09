import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const script = path.join(root, 'apps/ios/scripts/group-evidence.mjs');

for (const revision of ['before', 'after']) {
  test(`group evidence overlays ${revision} without replacing production disclosure`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nekko-group-evidence-'));
    try {
      for (const file of ['App/NekkoApp.swift', 'App/Views/ChatsView.swift', 'App/Platform/Prefs.swift', 'scripts/GroupEvidenceTests.swift']) {
        const target = path.join(dir, 'apps/ios', file.replace('scripts/', 'UITests/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(root, 'apps/ios', file), target);
      }
      execFileSync(process.execPath, [script, `--${revision}`], { cwd: dir });
      const read = file => fs.readFileSync(path.join(dir, 'apps/ios', file), 'utf8');
      const view = read('App/Views/ChatsView.swift');
      assert.ok(view.includes('private var opened: Set<String> { prefs.openedChatGroups }'));
      assert.ok(view.includes('withAnimation { flip(&prefs.openedChatGroups, g.key) }'));
      assert.ok(view.includes('guard query.isEmpty else { return }'));
      assert.ok(view.includes('DisclosureGroup("Card details")'));
      assert.ok(read('App/NekkoApp.swift').includes('let flags = ["-uiTestGroupList", '));
      const prefs = read('App/Platform/Prefs.swift');
      assert.ok(prefs.includes('!ProcessInfo.processInfo.arguments.contains("-uiTestKeepGroups")'));
      assert.ok(prefs.includes('openedChatGroups = Set(d.stringArray(forKey: "openedChatGroups") ?? [])'));
      const ui = read('UITests/GroupEvidenceTests.swift');
      assert.ok(ui.includes(`let remembersGroups = ${revision === 'after'}`));
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

// The native AX tree speaks PR metadata rather than its on-screen #42 badge.
test('card details checks real spoken fields and keeps reveal drags inside the Form', () => {
  const ui = fs.readFileSync(path.join(root, 'apps/ios/scripts/GroupEvidenceTests.swift'), 'utf8');
  assert.ok(ui.includes('marker: "Pull request 42, open"'));
  assert.ok(ui.includes('popover.frame.contains(element.frame)'));
  assert.ok(ui.includes('for down in [false, true]'));
  assert.ok(ui.includes('CGVector(dx: 0.05, dy: down ? 0.25 : 0.8)'));
  assert.ok(ui.includes('CGVector(dx: 0.05, dy: down ? 0.8 : 0.25)'));
  assert.ok(!ui.includes('form.swipeDown()'));
  assert.ok(ui.includes('other < index ? "0" : "1"'));
  assert.ok(ui.includes('other > index'));
  assert.ok(ui.includes('"-uiTestKeepCardDetails"'));
  assert.ok(ui.includes('XCTAssertFalse(row(app).label.contains(field.marker)'));
});

// iOS27 exposes a whole Form row as a Switch with an actual switch child.
test('card details drives the native switch thumb and retains post-tap checks', () => {
  const ui = fs.readFileSync(path.join(root, 'apps/ios/scripts/GroupEvidenceTests.swift'), 'utf8');
  assert.ok(ui.includes('let thumb = control.switches.firstMatch'));
  assert.ok(ui.includes('XCTAssertTrue(thumb.exists, fields[index].setting)'));
  assert.ok(ui.includes('control.frame.contains(thumb.frame)'));
  assert.ok(ui.includes('XCTAssertTrue(thumb.isHittable, fields[index].setting)'));
  assert.ok(ui.includes('thumb.tap()'));
  assert.ok(!ui.includes('control.tap()'));
  assert.ok(ui.includes('XCTAssertEqual(control.value as? String, "0", fields[index].setting)'));
});
