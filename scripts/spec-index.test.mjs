import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slug, writeIndex } from './spec-index.mjs';

test('slugs headings the way GitHub anchors them', () => {
  assert.equal(slug('Speed & responsiveness (the speed contract)'), 'speed--responsiveness-the-speed-contract');
  assert.equal(slug("Who It's For"), 'who-its-for');
  assert.equal(slug('Mode panel and saved modes (2026-10-17)'), 'mode-panel-and-saved-modes-2026-10-17');
});

test('writes the index between its markers and reports a stale one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-index-'));
  fs.mkdirSync(path.join(root, 'spec', 'chat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'spec', 'chat', 'find.md'), '---\ntitle: "Find in this chat"\narea: chat\n---\n\n# Find in this chat\n');
  fs.writeFileSync(path.join(root, 'spec', 'README.md'), '# Spec\n\nIntro stays.\n\n<!-- index:start -->\n<!-- index:end -->\n');
  assert.equal(writeIndex(root, { check: true }), false);
  writeIndex(root);
  const out = fs.readFileSync(path.join(root, 'spec', 'README.md'), 'utf8');
  assert.match(out, /Intro stays\./);
  assert.match(out, /- \[Find in this chat\]\(chat\/find\.md\) \(1 KB\)/);
  assert.equal(writeIndex(root, { check: true }), true);
  fs.rmSync(root, { recursive: true });
});

test('refuses a spec file without its area', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-index-'));
  fs.mkdirSync(path.join(root, 'spec', 'chat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'spec', 'chat', 'x.md'), '# No frontmatter\n');
  fs.writeFileSync(path.join(root, 'spec', 'README.md'), '<!-- index:start -->\n<!-- index:end -->\n');
  assert.throws(() => writeIndex(root), /frontmatter needs title and area/);
  fs.rmSync(root, { recursive: true });
});

test('the repository index is current', () => {
  assert.equal(writeIndex(path.resolve(import.meta.dirname, '..'), { check: true }), true, 'run node scripts/spec-index.mjs');
});
