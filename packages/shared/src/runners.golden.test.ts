import { readFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { IpcChannels } from './ipc.js';
import { DEFAULT_RUNNER_SETTINGS, KEEP_AWAKE_LABELS, PRIORITY_LABELS, REASONS, VPN_DIRECT_LABEL } from './runners.js';

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

it('runner channels match what the daemon serves', () => {
  const served: string[] = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'crates', 'nekko-remote', 'src', 'channels.json'), 'utf8'));
  const ours = Object.values(IpcChannels).filter((c) => c.startsWith('runner:')).sort();
  expect(ours).toEqual(served.filter((c) => c.startsWith('runner:')).sort());
});

it('documents every reason and the exact labels in docs/ci-runners.md', () => {
  const doc = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'ci-runners.md'), 'utf8');
  for (const r of Object.values(REASONS)) expect(doc).toContain(r.sentence);
  for (const l of [...Object.values(PRIORITY_LABELS), ...Object.values(KEEP_AWAKE_LABELS), VPN_DIRECT_LABEL]) expect(doc).toContain(l);
  expect(doc).not.toContain('\u2014');
});
