import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { QueuedPrompt, Session } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import * as sessions from './sessions.js';

/**
 * What `saveTurnSession` writes, which the engine daemon's port
 * (`SessionStore::save_turn`, crates/nekko-store/src/write.rs) must write byte
 * for byte: a running turn's chat saved over a file the user changed
 * meanwhile (a rename, options, a queued prompt), and the queue entry a
 * queued turn claims. Each case changes the file first (`disk`), then saves
 * the turn's copy (the fixture as it was, with `turn` applied). Rewrite with
 * UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-store', 'tests', 'golden');

type Op = [string, ...unknown[]];

/** `updatedAt` is the save time, the one field the two sides cannot agree on. */
const normalize = (text: string) => text.replace(/"updatedAt": \d+/g, '"updatedAt": 0');

interface Case {
  name: string;
  fixture: string;
  disk: Op[];
  turn: Record<string, unknown>;
  queued?: { index: number; item: QueuedPrompt };
  /** Delete the file before saving (a chat deleted mid-turn). */
  deleted?: boolean;
}

const reply = { id: 'a_new', role: 'assistant', content: 'Done.', createdAt: 5 };

const CASES: Case[] = [
  { name: 'plain', fixture: 's_tools', disk: [], turn: { messagesAppend: [reply], activeRun: { startedAt: 1 } } },
  { name: 'user renamed and changed options', fixture: 's_tools', disk: [['setOptions', { title: 'Mine', pinned: true, mode: 'ask', thinking: false }], ['setSpecLinked', true]], turn: { title: 'Auto title', titleAuto: true, messagesAppend: [reply] } },
  { name: 'turn set fields the disk lacks', fixture: 's_plain', disk: [], turn: { pinned: true, tags: ['x'], queue: ['stale'], agentPlan: [{ id: 'step_1', title: 'a', status: 'pending', createdAt: 1, updatedAt: 1 }] } },
  { name: 'queued claim', fixture: 's_extra', disk: [['queue', 'first'], ['queue', { text: 'second', images: ['i'] }], ['queue', 'third']], turn: { messagesAppend: [{ id: 'u_q', role: 'user', content: 'second', createdAt: 6 }] }, queued: { index: 2, item: { text: 'second', images: ['i'] } } },
  { name: 'queued string claim', fixture: 's_extra', disk: [['queue', 'only']], turn: {}, queued: { index: 1, item: { text: 'only' } } },
  { name: 'queued changed', fixture: 's_extra', disk: [['queue', 'first']], turn: {}, queued: { index: 0, item: 'other' } },
  { name: 'queued gone', fixture: 's_extra', disk: [], turn: {}, queued: { index: 5, item: 'x' } },
  { name: 'deleted mid-turn', fixture: 's_plain', disk: [], turn: { messagesAppend: [reply] }, deleted: true },
  { name: 'deleted mid-turn queued', fixture: 's_plain', disk: [], turn: {}, queued: { index: 0, item: 'x' }, deleted: true },
];

function applyDisk(id: string, [name, ...args]: Op): void {
  switch (name) {
    case 'setOptions': sessions.setSessionOptions(id, args[0] as never); return;
    case 'setSpecLinked': sessions.setSpecLinked(id, args[0] as boolean); return;
    case 'queue': sessions.queuePrompt(id, args[0] as string); return;
    default: throw new Error(`unknown op ${name}`);
  }
}

/** The turn's in-memory copy: the fixture as the turn read it, with its own changes. */
export function turnCopy(fixture: Session, turn: Record<string, unknown>): Session {
  const s = structuredClone(fixture) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(turn)) {
    if (k === 'messagesAppend') (s.messages as unknown[]).push(...(v as unknown[]));
    else s[k] = v;
  }
  return s as unknown as Session;
}

describe('turn save golden set', () => {
  it('matches what saveTurnSession writes', () => {
    const actual: Record<string, unknown> = {};
    for (const c of CASES) {
      const dir = mkdtempSync(join(tmpdir(), 'nekko-turn-save-'));
      try {
        setDataDir(dir);
        mkdirSync(join(dir, 'sessions'), { recursive: true });
        const file = join(dir, 'sessions', `${c.fixture}.json`);
        copyFileSync(join(golden, 'sessions', `${c.fixture}.json`), file);
        const fixture = JSON.parse(readFileSync(file, 'utf8')) as Session;
        for (const op of c.disk) applyDisk(c.fixture, op);
        if (c.deleted) rmSync(file);
        const copy = turnCopy(fixture, c.turn);
        let error: string | null = null;
        try {
          sessions.saveTurnSession(copy, c.queued);
        } catch (e) {
          error = (e as Error).message;
        }
        let written: string | null = null;
        try { written = normalize(readFileSync(file, 'utf8')); } catch { /* none */ }
        actual[c.name] = { error, written, memory: normalize(JSON.stringify(copy, null, 2)) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const path = join(golden, 'turn-saves.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify({ cases: CASES, expected: actual }, null, 2)}\n`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify({ cases: CASES, expected: actual })));
  });
});
