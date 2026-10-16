import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@nekko-agent/shared';
import { asSeenByChatModel, createRunawayGuard, fromLatestCompaction, repairInterruptedHistory, windowHistory, withoutImages } from '@nekko-agent/core';

/**
 * What the agent loop's message helpers do, which the engine daemon's port
 * (crates/nekko-loop) must reproduce exactly: where the runaway guard trips on
 * each recorded stream, how an interrupted transcript is repaired, what a
 * history window keeps, how a picture-only reply reads to a chat model, and
 * what a model that cannot see is sent in place of pictures.
 * Inputs are `golden/cases.json`; rewrite the expectations with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-loop', 'tests', 'golden');

describe('agent loop helpers golden set', () => {
  it('matches what the TS loop helpers produce', () => {
    const cases = JSON.parse(readFileSync(join(golden, 'cases.json'), 'utf8'));
    const streams = cases.streams.map((s: { name: string; opts?: object; deltas: string[] }) => {
      const guard = createRunawayGuard(s.opts ?? {});
      let at = -1;
      s.deltas.forEach((d, i) => { if (guard.push(d) && at < 0) at = i; });
      return { name: s.name, trippedAt: at, tripped: guard.tripped };
    });
    const repairs = cases.histories.map((h: { name: string; history: ChatMessage[] }) => {
      const history = structuredClone(h.history);
      const filled = repairInterruptedHistory(history);
      // Patch ids come from a process-wide counter.
      return { name: h.name, filled, history: JSON.parse(JSON.stringify(history).replace(/msg_repair_\d+/g, 'msg_repair_N')) };
    });
    const windows = cases.windows.map((w: { turns: number | null }) => ({
      turns: w.turns,
      kept: windowHistory(cases.conversation, w.turns ?? undefined).map((m: ChatMessage) => m.id),
    }));
    const seen = cases.seen.map((m: ChatMessage) => asSeenByChatModel(m));
    const compacted = cases.compacted.map((c: { name: string; history: ChatMessage[] }) => ({ name: c.name, sent: fromLatestCompaction(c.history) }));
    const blind = cases.blind.map((m: ChatMessage) => withoutImages(m));
    const actual = JSON.parse(JSON.stringify({ streams, repairs, windows, seen, compacted, blind }));
    const path = join(golden, 'expected.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 1)}\n`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(actual);
  });
});
