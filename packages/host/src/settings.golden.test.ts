import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCENT, LEGACY_ACCENTS } from '@nekko-agent/shared';
import { withDataDir } from './paths.js';
import { defaultSettings, getSettings, resetSettings, saveSettings } from './store.js';

/**
 * What the engine daemon's settings port (crates/nekko-settings) must
 * reproduce exactly: the defaults it embeds, and for every case in
 * `golden/cases.json` what getSettings / saveSettings / resetSettings return
 * and the bytes they leave in settings.json. Fails when either file is stale;
 * rewrite both with `UPDATE_GOLDEN=1`, then the Rust test holds the port to it.
 */
const crate = join(__dirname, '..', '..', '..', 'crates', 'nekko-settings');
const golden = join(crate, 'tests', 'golden');

interface Op { op: 'get' | 'update' | 'reset'; patch?: unknown }
interface Case { name: string; file: string | null; ops: Op[] }

function check(path: string, text: string): void {
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
  expect(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).toBe(text);
}

describe('settings golden set', () => {
  it('embeds the defaults the TS host starts from', () => {
    const text = `${JSON.stringify({ defaults: defaultSettings(), defaultAccent: DEFAULT_ACCENT, legacyAccents: LEGACY_ACCENTS }, null, 2)}\n`;
    check(join(crate, 'src', 'defaults.json'), text);
  });

  it('matches what the store returns and writes for every case', () => {
    const cases = JSON.parse(readFileSync(join(golden, 'cases.json'), 'utf8')) as Case[];
    const actual = cases.map((c) => {
      const dir = mkdtempSync(join(tmpdir(), 'nekko-settings-golden-'));
      try {
        if (c.file !== null) writeFileSync(join(dir, 'settings.json'), c.file);
        const results = withDataDir(dir, () =>
          c.ops.map((o) => {
            try {
              const value =
                o.op === 'get' ? getSettings() : o.op === 'reset' ? resetSettings() : saveSettings(o.patch as never);
              return { value: JSON.stringify(value) };
            } catch {
              return { error: true };
            }
          }),
        );
        const path = join(dir, 'settings.json');
        return { name: c.name, results, file: existsSync(path) ? readFileSync(path, 'utf8') : null };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    check(join(golden, 'expected.json'), `${JSON.stringify(actual, null, 2)}\n`);
  });
});
