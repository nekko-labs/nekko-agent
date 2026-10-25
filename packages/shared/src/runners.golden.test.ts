import { readFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { DEFAULT_RUNNER_SETTINGS, REASONS } from './runners.js';

/**
 * The runner fixtures are the serde output crates/nekko-runner's tests pin
 * (tests/settings.rs, tests/gates.rs), so a Rust change to the defaults or the
 * `Reason` list fails here until the TS mirror follows.
 */
const fixtures = join(__dirname, '..', '..', '..', 'crates', 'nekko-runner', 'tests', 'fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

it('has a sentence for every reason the daemon sends', () => {
  const names: string[] = fixture('reasons.json');
  expect(Object.keys(REASONS)).toEqual(names);
  for (const r of names) {
    expect(REASONS[r as keyof typeof REASONS].sentence).toMatch(/\.$/);
    expect(REASONS[r as keyof typeof REASONS].short).not.toMatch(/\.$/);
  }
});

it('matches the Rust defaults', () => {
  expect(DEFAULT_RUNNER_SETTINGS).toEqual(fixture('default-settings.json'));
});
