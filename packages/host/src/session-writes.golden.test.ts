import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { setDataDir } from './paths.js';
import * as sessions from './sessions.js';
import { applySandboxSetup } from './execution-router.js';

/**
 * The files the TS session writes produce, which the engine daemon's port
 * (crates/nekko-store/src/write.rs) must reproduce byte for byte. Both sides
 * run `golden/ops.json` on copies of the golden fixtures; `updatedAt` is the
 * only field normalized, since it is the save time. Rewrite with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-store', 'tests', 'golden');
type Op = [string, ...unknown[]];

function apply(id: string, [name, ...args]: Op): unknown {
  switch (name) {
    case 'setOptions': return sessions.setSessionOptions(id, args[0] as never);
    case 'setWorkspace': return sessions.setSessionWorkspace(id, (args[0] ?? undefined) as string | undefined);
    case 'setSupporting': return sessions.setSessionSupportingWorkspaces(id, args[0] as string[]);
    case 'setAttachments': return sessions.setSessionAttachments(id, args[0] as string[]);
    case 'setSpecLinked': return sessions.setSpecLinked(id, args[0] as boolean);
    case 'truncate': return sessions.truncateSession(id, args[0] as string);
    case 'queue': return sessions.queuePrompt(id, args[0] as string);
    case 'dequeue': return sessions.dequeuePrompt(id, args[0] as number);
    case 'editQueued': return sessions.editQueuedPrompt(id, args[0] as number, args[1] as never);
    case 'autoTitle': return sessions.applyAutoTitle(id, args[0] as string);
    case 'configureSandbox': {
      const s = sessions.getSession(id)!;
      applySandboxSetup(s, args[0] as string, args[1] as string, args[2] as number);
      return sessions.saveSession(s);
    }
    default: throw new Error(`unknown op ${name}`);
  }
}

export const normalize = (text: string) => text.replace(/"updatedAt": \d+/g, '"updatedAt": 0');

describe('session writes golden set', () => {
  it('matches what sessions.ts writes for every op sequence', () => {
    const cases = JSON.parse(readFileSync(join(golden, 'ops.json'), 'utf8')) as Array<{ fixture: string; ops: Op[] }>;
    const actual: Record<string, string> = {};
    for (const c of cases) {
      const dir = mkdtempSync(join(tmpdir(), 'nekko-writes-'));
      try {
        setDataDir(dir);
        mkdirSync(join(dir, 'sessions'), { recursive: true });
        copyFileSync(join(golden, 'sessions', `${c.fixture}.json`), join(dir, 'sessions', `${c.fixture}.json`));
        const errors: string[] = [];
        for (const op of c.ops) {
          try {
            apply(c.fixture, op);
          } catch (e) {
            errors.push((e as Error).message);
          }
        }
        actual[c.fixture] = normalize(readFileSync(join(dir, 'sessions', `${c.fixture}.json`), 'utf8'));
        if (errors.length) actual[`${c.fixture}:errors`] = JSON.stringify(errors);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const path = join(golden, 'writes.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(actual);
  });
});
