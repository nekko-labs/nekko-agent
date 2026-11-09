import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@nekko-agent/shared';
import { UNCONFIRMED_RUN_MAX_MS, __resetLiveRuns, applyEvent, getLiveRun, onRunOrphaned, reconcileRunning, takeFinishedRun } from './liveRuns.js';
import { localAgentStarts, reportAgentWorking } from './workingAgents.js';

vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});

const reasoning = (sessionId: string): AgentEvent => ({ type: 'reasoning', sessionId, delta: 'hmm' });

describe('reconcileRunning', () => {
  beforeEach(() => __resetLiveRuns());

  it('ends a confirmed run the engine stops listing, after a second miss', () => {
    const heard: string[] = [];
    onRunOrphaned((id) => heard.push(id));
    reportAgentWorking('a', true);
    applyEvent(reasoning('a'), 1_000);
    expect(reconcileRunning(['a'], 2_000)).toEqual([]);
    // The engine restarted: its new list no longer has the chat.
    expect(reconcileRunning([], 32_000)).toEqual([]);
    expect(getLiveRun('a')).toBeDefined();
    expect(reconcileRunning([], 62_000)).toEqual(['a']);
    expect(getLiveRun('a')).toBeUndefined();
    expect(takeFinishedRun('a')).toBeDefined();
    expect(localAgentStarts()).not.toContain('a');
    expect(heard).toEqual(['a']);
  });

  it('keeps a run that heard an event after the list was asked for', () => {
    applyEvent(reasoning('a'), 1_000);
    reconcileRunning(['a'], 2_000);
    reconcileRunning([], 30_000);
    applyEvent(reasoning('a'), 61_000);
    expect(reconcileRunning([], 60_000)).toEqual([]);
    expect(getLiveRun('a')).toBeDefined();
  });

  it('a listed run clears an earlier miss', () => {
    applyEvent(reasoning('a'), 1_000);
    reconcileRunning(['a'], 2_000);
    reconcileRunning([], 32_000);
    reconcileRunning(['a'], 62_000);
    expect(reconcileRunning([], 92_000)).toEqual([]);
    expect(getLiveRun('a')).toBeDefined();
  });

  it('gives a never-confirmed run until the setup limit before ending it', () => {
    applyEvent(reasoning('b'), 1_000);
    expect(reconcileRunning([], 2_000)).toEqual([]);
    expect(reconcileRunning([], 1_000 + UNCONFIRMED_RUN_MAX_MS - 1)).toEqual([]);
    expect(reconcileRunning([], 1_000 + UNCONFIRMED_RUN_MAX_MS)).toEqual(['b']);
  });
});
