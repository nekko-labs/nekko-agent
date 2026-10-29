import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@nekko-agent/shared';
import { WorkingAgents } from './workingAgents.js';
const event = (type: AgentEvent['type'], sessionId: string) => ({ type, sessionId }) as AgentEvent;

describe('aggregate working indicator', () => {
  it('stays active until the last agent finishes, including background agents', () => {
    const s = new WorkingAgents();
    s.event(event('text', 'background-a'));
    s.event(event('text', 'b'));
    expect(s.working).toBe(true);
    s.event(event('done', 'background-a'));
    expect(s.working).toBe(true);
    s.event(event('error', 'b'));
    expect(s.working).toBe(false);
  });
  it('excludes approval and question waits, resumes on progress, and ignores bookkeeping', () => {
    const s = new WorkingAgents();
    s.event(event('session_meta', 'a'));
    s.event(event('compaction', 'a'));
    expect(s.working).toBe(false);
    s.event(event('text', 'a'));
    s.event(event('question', 'a'));
    expect(s.working).toBe(false);
    s.event(event('question_resolved', 'a'));
    expect(s.working).toBe(true);
    s.event(event('tool_approval_required', 'a'));
    expect(s.working).toBe(false);
    s.event(event('tool_result', 'a'));
    expect(s.working).toBe(true);
  });
  it('hydrates existing runs without resurrecting completed or unblocking waiting agents', () => {
    const s = new WorkingAgents();
    s.event(event('done', 'a'));
    s.event(event('question', 'b'));
    s.hydrate(['a', 'b'], {});
    expect(s.working).toBe(false);
    s.hydrate(['c'], { c: { approval: {} } } as never);
    expect(s.working).toBe(false);
    s.event(event('text', 'd'));
    expect(s.working).toBe(true);
    s.event(event('done', 'd'));
    expect(s.working).toBe(false);
  });
});
