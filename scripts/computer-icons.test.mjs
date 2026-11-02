import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { androidDir, iosDir, pathData, root } from './computer-icons.mjs';

const read = (path) => readFileSync(join(root, path), 'utf8');
const quoted = (block) => [...block.matchAll(/["']([a-z]+)["']/g)].map((m) => m[1]);

const shared = read('packages/shared/src/computers.ts').match(/COMPUTER_ICONS = \[([\s\S]*?)\]/)[1];
const names = quoted(shared);

test('COMPUTER_ICONS reads as the 24 names', () => {
  assert.equal(names.length, 24);
});

test('every computer icon has its iPhone asset, and no asset is left over', () => {
  for (const name of names) {
    assert.ok(existsSync(join(iosDir, `computer-${name}.imageset/computer-${name}.svg`)), `no iOS asset for ${name}`);
    const set = JSON.parse(readFileSync(join(iosDir, `computer-${name}.imageset/Contents.json`), 'utf8'));
    assert.equal(set.properties['template-rendering-intent'], 'template');
    assert.equal(set.properties['preserves-vector-representation'], true);
  }
  const sets = readdirSync(iosDir).filter((f) => f.endsWith('.imageset'));
  assert.deepEqual(sets.sort(), names.map((n) => `computer-${n}.imageset`).sort());
});

test('every computer icon has its Android drawable and its entry in the app, and no drawable is left over', () => {
  const res = read('apps/android/app/src/main/java/com/nekko/android/ui/components/ComputerIcon.kt');
  for (const name of names) {
    assert.ok(existsSync(join(androidDir, `computer_icon_${name}.xml`)), `no Android drawable for ${name}`);
    assert.match(res, new RegExp(`"${name}" -> R\\.drawable\\.computer_icon_${name}\\b`), `no drawable mapped for ${name}`);
  }
  const drawables = readdirSync(androidDir).filter((f) => f.startsWith('computer_icon_'));
  assert.deepEqual(drawables.sort(), names.map((n) => `computer_icon_${n}.xml`).sort());
});

test('each phone lists the same icons in the same order', () => {
  const swift = read('apps/ios/Protocol/Sources/NekkoProtocol/Wire.swift').match(/computerIcons = \[([\s\S]*?)\]/)[1];
  const kotlin = read('apps/android/protocol/src/main/kotlin/com/nekko/protocol/Wire.kt').match(/COMPUTER_ICONS = listOf\(([\s\S]*?)\)/)[1];
  assert.deepEqual(quoted(swift), names);
  assert.deepEqual(quoted(kotlin), names);
});

test('every icon has a label for the iPhone picker', () => {
  const views = read('apps/ios/App/Views/ComputerViews.swift');
  for (const name of names) assert.match(views, new RegExp(`case "${name}":`), `no label for ${name}`);
});

test('pathData turns rects and circles into paths', () => {
  const svg = (inner) => `<svg viewBox="0 0 24 24">${inner}</svg>`;
  assert.equal(pathData(svg('<path d="M3 19h18"></path>')), 'M3 19h18');
  assert.equal(pathData(svg('<circle cx="12" cy="16" r="1"></circle>')), 'M11 16a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z');
  assert.equal(pathData(svg('<rect x="5" y="5" width="14" height="10" rx="1.5"></rect>')),
    'M6.5 5h11a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1 -1.5 1.5h-11a1.5 1.5 0 0 1 -1.5 -1.5v-7a1.5 1.5 0 0 1 1.5 -1.5Z');
  assert.equal(pathData(svg('<rect x="1" y="1" width="2" height="2"></rect><path d="M0 0h1"></path>')),
    'M1 1h2a0 0 0 0 1 0 0v2a0 0 0 0 1 0 0h-2a0 0 0 0 1 0 0v-2a0 0 0 0 1 0 0ZM0 0h1');
});

test('pathData keeps a shape that starts with a relative move where it is drawn', () => {
  const svg = '<svg><rect x="3" y="5" width="18" height="14"></rect><path d="m7 10 3 2-3 2M12 15h5"></path></svg>';
  assert.match(pathData(svg), /ZM7 10l3 2-3 2M12 15h5$/);
  assert.equal(pathData('<svg><path d="m4 11h2"></path></svg>'), 'M4 11h2');
});

test('pathData refuses a shape it would otherwise drop', () => {
  assert.throws(() => pathData('<svg><line x1="0"></line></svg>'), /No conversion/);
  assert.throws(() => pathData('<svg><g><path d="M0 0"></path></g></svg>'), /Unexpected markup/);
});
