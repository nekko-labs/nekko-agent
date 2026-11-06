import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNotices, findProblems, licenseAllowed, parseAssets } from './third-party.mjs';

const allow = ['MIT', 'Apache-2.0', 'Apache-2.0 WITH LLVM-exception', 'Unicode-3.0'];

test('reads SPDX expressions, including the old Cargo slash', () => {
  assert.equal(licenseAllowed('MIT', allow), true);
  assert.equal(licenseAllowed('GPL-3.0-only', allow), false);
  assert.equal(licenseAllowed('MIT OR GPL-3.0-only', allow), true);
  assert.equal(licenseAllowed('MIT AND GPL-3.0-only', allow), false);
  assert.equal(licenseAllowed('MIT/Apache-2.0', allow), true);
  assert.equal(licenseAllowed('Apache-2.0 / MIT', allow), true);
  assert.equal(licenseAllowed('(MIT OR GPL-3.0-only) AND Unicode-3.0', allow), true);
  assert.equal(licenseAllowed('(MIT OR Apache-2.0) AND GPL-3.0-only', allow), false);
  assert.equal(licenseAllowed('GPL-3.0-only OR MIT AND Unicode-3.0', allow), true);
  assert.equal(licenseAllowed('Apache-2.0 WITH LLVM-exception OR GPL-3.0-only', allow), true);
  assert.equal(licenseAllowed('SEE LICENSE IN LICENSE.md', allow), false);
});

const clean = { packages: [], crates: [], assets: [], policy: { allow, exceptions: {} }, fileExists: () => true };
const asset = { Name: 'Icons', 'Used for': 'UI', Version: '1', License: 'MIT', 'License file': 'LICENSE', Source: 'https://example.com' };

test('a disallowed or undeclared package fails, an exception passes', () => {
  const packages = [{ name: 'copyleft', version: '1.0.0', license: 'GPL-3.0-only' }, { name: 'blank', version: '1.0.0', license: null }];
  assert.equal(findProblems({ ...clean, packages }).length, 2);
  const policy = { allow, exceptions: { copyleft: 'approved', blank: 'MIT in its file' } };
  assert.deepEqual(findProblems({ ...clean, packages, policy }), []);
});

test('an asset needs every column and a license file that exists', () => {
  assert.deepEqual(findProblems({ ...clean, assets: [asset] }), []);
  assert.match(findProblems({ ...clean, assets: [{ ...asset, Source: '' }] })[0], /no Source/);
  assert.match(findProblems({ ...clean, assets: [asset], fileExists: () => false })[0], /does not exist/);
  assert.deepEqual(findProblems({ ...clean, assets: [{ ...asset, 'License file': '-' }], fileExists: () => false }), []);
});

test('parses the ASSETS.md table and ignores the prose around it', () => {
  const rows = parseAssets('# Credits\n\nThanks.\n\n| Name | Source |\n| --- | --- |\n| Icons | https://a.b |\n\nMore prose.\n');
  assert.deepEqual(rows, [{ Name: 'Icons', Source: 'https://a.b' }]);
});

test('notices skip dev tools but keep what the bundler pulled in', () => {
  const pkg = (name, dev) => ({ name, version: '1.0.0', license: 'MIT', dir: `node_modules/${name}`, dev, platform: false });
  const text = buildNotices({
    packages: [pkg('react', true), pkg('vitest', true), pkg('ws', false)], crates: [], assets: [],
    bundled: new Set(['node_modules/react']), root: '/nowhere',
  });
  assert.match(text, /react 1\.0\.0/);
  assert.match(text, /ws 1\.0\.0/);
  assert.doesNotMatch(text, /vitest/);
});

test('packages with the same license text share one block', () => {
  const pkg = (name) => ({ name, version: '1.0.0', license: 'MIT', dir: `node_modules/${name}`, dev: false, platform: false });
  const text = buildNotices({ packages: [pkg('a'), pkg('b')], crates: [], assets: [], bundled: new Set(), root: '/nowhere' });
  assert.equal(text.match(/no license file in the published package/g).length, 1);
});
