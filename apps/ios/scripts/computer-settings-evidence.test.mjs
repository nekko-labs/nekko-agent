import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { overlayComputerSettings } from './computer-settings-evidence.mjs';

const flag = '"-uiTestComputerSettingsEvidence"';
const route = `if ProcessInfo.processInfo.arguments.contains(${flag}) { ComputerSettingsEvidenceFixture() } else`;
const anchor = 'if ProcessInfo.processInfo.arguments.contains("-uiTestVoiceConversation") { VoiceConversationFixture() } else';
const legacy = `let flags = ["-uiTestChatRefresh", "-uiTestNewChat"]\n${anchor}\nProductionView()`;

test('injects only the isolation flag and fixture route on a legacy baseline', () => {
  const expected = `let flags = [${flag}, "-uiTestChatRefresh", "-uiTestNewChat"]\n${route}\n        ${anchor}\nProductionView()`;
  assert.equal(overlayComputerSettings(legacy), expected);
  assert.equal(overlayComputerSettings(expected), expected);
});

test('does not depend on the first isolation flag', () => {
  assert.ok(overlayComputerSettings(legacy.replace('-uiTestChatRefresh', '-uiTestOther')).includes(`let flags = [${flag},`));
});

test('leaves an already-instrumented app byte-identical', () => {
  const source = fs.readFileSync(new URL('../App/NekkoApp.swift', import.meta.url), 'utf8');
  assert.ok(source.includes(route));
  assert.equal(overlayComputerSettings(source), source);
});

test('repairs either missing piece without duplicating the other', () => {
  const complete = overlayComputerSettings(legacy);
  assert.equal(overlayComputerSettings(complete.replace(`${flag}, `, '')), complete);
  assert.equal(overlayComputerSettings(complete.replace(`${route}\n        `, '')), complete);
});

test('rejects missing and ambiguous anchors before changing sources', () => {
  for (const source of [
    legacy.replace('let flags = [', 'let other = ['),
    `${legacy}\nlet flags = []`,
    legacy.replace(anchor, 'DifferentRoute()'),
    `${legacy}\n${anchor}`,
    overlayComputerSettings(legacy).replace(`${flag},`, `${flag}, ${flag},`),
    `${overlayComputerSettings(legacy)}\n${route}`,
  ]) assert.throws(() => overlayComputerSettings(source));
});
