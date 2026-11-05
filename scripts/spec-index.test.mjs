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

test('writes the index to spec/INDEX.md and returns it, leaving README.md alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-index-'));
  fs.mkdirSync(path.join(root, 'spec', 'chat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'spec', 'chat', 'find.md'), '---\ntitle: "Find in this chat"\narea: chat\n---\n\n# Find in this chat\n');
  fs.writeFileSync(path.join(root, 'spec', 'README.md'), '# Spec\n\nIntro stays.\n');
  const out = writeIndex(root);
  assert.match(out, /### chat\n\nThe chat surface/);
  assert.match(out, /- \[Find in this chat\]\(chat\/find\.md\) \(1 KB\)/);
  assert.equal(fs.readFileSync(path.join(root, 'spec', 'INDEX.md'), 'utf8'), out);
  assert.equal(fs.readFileSync(path.join(root, 'spec', 'README.md'), 'utf8'), '# Spec\n\nIntro stays.\n');
  fs.rmSync(root, { recursive: true });
});

test('reads a CRLF checkout the same as LF', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-index-'));
  fs.mkdirSync(path.join(root, 'spec', 'chat'), { recursive: true });
  const body = `---\ntitle: "Find in this chat"\narea: chat\n---\n\n${'x'.repeat(1700)}\n`;
  fs.writeFileSync(path.join(root, 'spec', 'chat', 'find.md'), body.replace(/\n/g, '\r\n'));
  assert.match(writeIndex(root), /- \[Find in this chat\]\(chat\/find\.md\) \(2 KB\)/);
  fs.rmSync(root, { recursive: true });
});

test('the check validates frontmatter and writes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-index-'));
  fs.mkdirSync(path.join(root, 'spec', 'chat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'spec', 'chat', 'find.md'), '---\ntitle: Find in this chat\narea: chat\n---\n');
  assert.equal(writeIndex(root, { check: true }), true);
  assert.equal(fs.existsSync(path.join(root, 'spec', 'INDEX.md')), false);
  fs.writeFileSync(path.join(root, 'spec', 'chat', 'x.md'), '# No frontmatter\n');
  assert.throws(() => writeIndex(root, { check: true }), /frontmatter needs title and area/);
  fs.rmSync(root, { recursive: true });
});

test('refuses an area without a description', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-index-'));
  fs.mkdirSync(path.join(root, 'spec', 'nowhere'), { recursive: true });
  fs.writeFileSync(path.join(root, 'spec', 'nowhere', 'x.md'), '---\ntitle: X\narea: nowhere\n---\n');
  assert.throws(() => writeIndex(root, { check: true }), /unknown area/);
  fs.rmSync(root, { recursive: true });
});

test('every spec file in the repository has valid frontmatter', () => {
  assert.equal(writeIndex(path.resolve(import.meta.dirname, '..'), { check: true }), true);
});
