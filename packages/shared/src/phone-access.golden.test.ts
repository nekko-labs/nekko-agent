import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { phoneAccessPolicy } from './phone-access.js';

/**
 * The phone access policy the engine daemon enforces
 * (crates/nekko-remote/src/phone.rs) is read from `phone-access.json`, written
 * from this package's `phoneAccessPolicy()`. Fails when the file is stale;
 * rewrite it with UPDATE_GOLDEN=1. The decisions recorded in
 * `tests/golden/phone.json` are a frozen record of the TS gate this replaced.
 */
const crate = join(__dirname, '..', '..', '..', 'crates', 'nekko-remote');

it('writes the phone access policy the daemon enforces', () => {
  const path = join(crate, 'src', 'phone-access.json');
  const policy = phoneAccessPolicy();
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(policy, null, 1)}\n`);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(policy)));
});

it('lets a phone call only public channels', () => {
  // `channels.json` is the list of public channels the daemon serves; a new
  // channel a phone may call is added there too, by hand.
  const served = new Set<string>(JSON.parse(readFileSync(join(crate, 'src', 'channels.json'), 'utf8')));
  for (const channel of phoneAccessPolicy().channels) expect(served.has(channel), channel).toBe(true);
});
