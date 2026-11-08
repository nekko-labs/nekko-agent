import assert from 'node:assert/strict';
import { test } from 'node:test';
import { posixFixture, posixFixtureOptions } from './posix-fixture.mjs';

test('native Windows reports why a POSIX execution fixture cannot run', () => {
  assert.match(posixFixtureOptions('win32').skip, /POSIX execution fixture/);
  assert.match(posixFixtureOptions('win32').skip, /Linux CI runs this case/);
});

test('POSIX fixtures are never skipped for missing tools on Linux or macOS', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    assert.equal(posixFixtureOptions(platform).skip, false);
  }
});

test('the fixture option follows the Node host, not an available shell', () => {
  assert.deepEqual(posixFixture, posixFixtureOptions(process.platform));
});
