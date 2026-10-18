import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { STARTER_MODES } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { getSettings } from './store.js';
import * as sessions from './sessions.js';

/**
 * What `createSession` makes, which the engine daemon's port
 * (crates/nekko-store/src/write.rs `create_with`) must reproduce key for key:
 * every case in `golden/create-cases.json` (settings, a folder, supporting
 * folders, a parent chat) over a scratch data dir. The settings each case
 * resolves to are recorded too, so the Rust side starts from the same ones.
 * The id and the times are normalized. Rewrite with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-store', 'tests', 'golden');

const normalize = (s: Record<string, unknown>) => ({ ...s, id: '<id>', createdAt: 0, updatedAt: 0 });

describe('session creation golden set', () => {
  it('matches what createSession writes', () => {
    const c = JSON.parse(readFileSync(join(golden, 'create-cases.json'), 'utf8'));
    const results: unknown[] = [];
    for (const k of c.cases) {
      const dir = mkdtempSync(join(tmpdir(), 'nekko-create-'));
      try {
        setDataDir(dir);
        mkdirSync(join(dir, 'sessions'), { recursive: true });
        writeFileSync(join(dir, 'settings.json'), JSON.stringify(k.settings));
        for (const [id, parent] of Object.entries(c.parents)) writeFileSync(join(dir, 'sessions', `${id}.json`), JSON.stringify(parent));
        const settings = getSettings();
        const made = sessions.createSession(k.workspaceId, k.parent, k.supporting);
        const saved = JSON.parse(readFileSync(join(dir, 'sessions', `${made.id}.json`), 'utf8'));
        results.push({ settings, saved: normalize(saved), idShape: /^s_[0-9a-z]+_[A-Za-z0-9_-]{8}$/.test(made.id) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const actual = { starterModes: STARTER_MODES, results };
    const text = `${JSON.stringify(actual, null, 2)}\n`;
    const path = join(golden, 'creates.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
});
