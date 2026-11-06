import { describe, it, expect, vi } from 'vitest';
import { applyEvent } from './liveRuns.js';
import { localAgentStarts, onLocalAgentWorking, reportAgentWorking } from './workingAgents.js';

vi.stubGlobal('requestAnimationFrame', () => 0);

describe('local sends', () => {
  it('tells a listener the moment a pane sends, before the host says anything, and when it ends', () => {
    const heard: Array<[string, boolean]> = [];
    const off = onLocalAgentWorking((id, working) => heard.push([id, working]));
    reportAgentWorking('fresh', true);
    expect(localAgentStarts()).toContain('fresh');
    reportAgentWorking('fresh', false);
    off();
    reportAgentWorking('later', true);
    expect(heard).toEqual([['fresh', true], ['fresh', false]]);
    expect(localAgentStarts()).not.toContain('fresh');
    reportAgentWorking('later', false);
  });
  it('ends with the turn, with no chat pane open to say so', () => {
    reportAgentWorking('done-away', true);
    reportAgentWorking('failed-away', true);
    reportAgentWorking('other', true);
    applyEvent({ type: 'done', sessionId: 'done-away', messageId: 'm' });
    applyEvent({ type: 'error', sessionId: 'failed-away', message: 'boom' });
    expect(localAgentStarts()).toEqual(['other']);
    reportAgentWorking('other', false);
  });
  it('outlasts everything short of the end of the turn', () => {
    reportAgentWorking('running', true);
    applyEvent({ type: 'text', sessionId: 'running', delta: 'x' });
    applyEvent({ type: 'session_meta', sessionId: 'running' });
    expect(localAgentStarts()).toContain('running');
    applyEvent({ type: 'done', sessionId: 'running', messageId: 'm' });
    expect(localAgentStarts()).not.toContain('running');
  });
});
