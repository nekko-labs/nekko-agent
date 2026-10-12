import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ARCHIVE_RETENTION_DAYS } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { forkSession, purgeExpiredArchives } from './sessions.js';

/**
 * What `forkSession` and `purgeExpiredArchives` leave on disk, which the
 * engine daemon's port (crates/nekko-store/src/write.rs `fork`,
 * `purge_archived_with`) must reproduce. A fork's file is held byte for
 * byte, key order included; only its new id and its timestamps are
 * normalized. Rewrite with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-store', 'tests', 'golden');

/** The fork's own id and save times: the top-level lines (two-space indent) only. */
export const normalizeFork = (text: string) =>
  text
    .replace(/^ {2}"id": "[^"]*",$/m, '  "id": "<fork>",')
    .replace(/^ {2}"createdAt": \d+/m, '  "createdAt": 0')
    .replace(/^ {2}"updatedAt": \d+/m, '  "updatedAt": 0');

function withDataDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-fork-'));
  try {
    setDataDir(dir);
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('session fork and archive purge golden set', () => {
  it('matches what forkSession writes for every case', () => {
    const cases = JSON.parse(readFileSync(join(golden, 'fork-cases.json'), 'utf8')) as Array<{
      name: string;
      before?: string;
      session: { id: string };
    }>;
    const actual: Record<string, string | null> = {};
    for (const c of cases) {
      actual[c.name] = withDataDir((dir) => {
        const srcFile = join(dir, 'sessions', `${c.session.id}.json`);
        const srcText = JSON.stringify(c.session, null, 2);
        writeFileSync(srcFile, srcText);
        const fork = forkSession(c.session.id, c.before);
        // The source chat is never touched.
        expect(readFileSync(srcFile, 'utf8')).toBe(srcText);
        if (!fork) return null;
        const files = readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.json'));
        expect(files.sort()).toEqual([`${c.session.id}.json`, `${fork.id}.json`].sort());
        expect(fork.id).toMatch(/^s_[0-9a-z]+_[A-Za-z0-9_-]{8}$/);
        return normalizeFork(readFileSync(join(dir, 'sessions', `${fork.id}.json`), 'utf8'));
      });
    }
    actual.no_such_chat = withDataDir(() => {
      expect(forkSession('s_absent')).toBeNull();
      return null;
    });
    const path = join(golden, 'forks.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(actual);
  });

  it('matches which chats purgeExpiredArchives deletes', () => {
    const now = 1_760_000_000_000;
    const window = ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const values: unknown[] = [undefined, null, 0, -5, String(now - window - 1), true, now - window - 1, now - window, now - window + 1, now, 1, 0.5];
    const sessions = values.map((archivedAt, i) => ({ id: `s_${i}`, title: 'Test', messages: [], createdAt: 1, updatedAt: 1000 - i, archivedAt }));
    const actual = withDataDir((dir) => {
      for (const s of sessions) writeFileSync(join(dir, 'sessions', `${s.id}.json`), JSON.stringify(s));
      writeFileSync(join(dir, 'sessions', 'broken.json'), '{');
      writeFileSync(join(dir, 'sessions', 's_null.json'), 'null');
      const count = purgeExpiredArchives(now);
      const remaining = readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
      return { now, sessions, count, remaining };
    });
    const path = join(golden, 'purge.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
  });
});
