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
