import { describe, expect, it } from 'vitest';
import type { ChatMessage, PendingInput } from './chat.js';
import { isStalled, recentTurns, sessionLane } from './session-board.js';

const msg = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m_${role}_${content.slice(0, 4)}`,
  role,
  content,
  createdAt: 0,
  ...extra,
});

const question: PendingInput = {
  sessionId: 's1',
  question: {
    callId: 'c1',
    askedAt: 1_000,
    questions: [{ id: 'q1', header: 'Scope', question: 'How far?', options: [{ label: 'a' }, { label: 'b' }] }],
  },
};

const approval: PendingInput = {
  sessionId: 's1',
  approval: {
    call: { id: 'c2', name: 'bash', input: { command: 'rm -rf build' } },
    reason: 'Destructive command',
    severity: 'high',
    requestedAt: 2_000,
  },
};

describe('sessionLane', () => {
  const done = [msg('user', 'go'), msg('assistant', 'done')];

  it('puts a chat that is waiting on you first, even while its turn is live', () => {
    // The turn *is* still running when the agent asks — it is parked inside a
    // tool call. Reading that as "working" would hide the one card the board
    // exists to surface.
    expect(sessionLane({ running: true, pending: question, messages: done })).toEqual({
      lane: 'needs-you',
      blocked: 'question',
    });
    expect(sessionLane({ running: true, pending: approval, messages: done })).toEqual({
      lane: 'needs-you',
      blocked: 'approval',
    });
  });

  it('is working when it is running and nothing is blocked', () => {
    expect(sessionLane({ running: true, messages: done })).toEqual({ lane: 'working' });
  });

  it('is idle when the last reply finished', () => {
    expect(sessionLane({ running: false, messages: done })).toEqual({ lane: 'idle' });
    expect(sessionLane({ running: false, messages: [] })).toEqual({ lane: 'idle' });
  });

  it('surfaces a reply that was cut off as something to deal with', () => {
    const cut = [msg('user', 'go'), msg('assistant', 'I was half way through', { interrupted: true })];
    expect(sessionLane({ running: false, messages: cut })).toEqual({ lane: 'needs-you', blocked: 'interrupted' });
  });

  it('reads the stall off a summary the same way', () => {
    expect(sessionLane({ running: false, stalled: true })).toEqual({ lane: 'needs-you', blocked: 'interrupted' });
    expect(sessionLane({ running: false, stalled: false })).toEqual({ lane: 'idle' });
    expect(sessionLane({ running: true, stalled: true })).toEqual({ lane: 'working' });
  });

  it('does not call a chat stalled once it is running again', () => {
    const cut = [msg('user', 'go'), msg('assistant', 'half', { interrupted: true })];
    expect(sessionLane({ running: true, messages: cut })).toEqual({ lane: 'working' });
  });

  it('only reads the last message as the stall', () => {
    // An interruption the user already carried on from is history, not a state.
    const recovered = [
      msg('user', 'go'),
      msg('assistant', 'half', { interrupted: true }),
      msg('user', 'carry on'),
      msg('assistant', 'finished'),
    ];
    expect(isStalled(recovered)).toBe(false);
    expect(sessionLane({ running: false, messages: recovered })).toEqual({ lane: 'idle' });
  });
});

describe('recentTurns', () => {
  const history: ChatMessage[] = [
    msg('user', 'first ask', { id: 'u1', createdAt: 1 }),
    msg('assistant', 'first answer', { id: 'a1', createdAt: 2 }),
    msg('user', 'second ask', { id: 'u2', createdAt: 3 }),
    msg('assistant', '', { id: 'a2', createdAt: 4, toolCalls: [{ id: 't1', name: 'bash', input: {} }] }),
    msg('tool', 'command output', { id: 'r1', createdAt: 5 }),
    msg('assistant', 'second answer', { id: 'a3', createdAt: 6 }),
  ];

  it('returns both sides of the exchange, oldest first', () => {
    expect(recentTurns(history, 4).map((t) => [t.role, t.text])).toEqual([
      ['user', 'first ask'],
      ['assistant', 'first answer'],
      ['user', 'second ask'],
      ['assistant', 'second answer'],
    ]);
  });

  it('drops the working steps: tool output and replies that only called tools', () => {
    expect(recentTurns(history, 10).map((t) => t.id)).not.toContain('a2');
    expect(recentTurns(history, 10).map((t) => t.id)).not.toContain('r1');
  });

  it('takes the newest turns when there are more than asked for', () => {
    expect(recentTurns(history, 2).map((t) => t.id)).toEqual(['u2', 'a3']);
  });

  it('marks a reply that was cut off, so the card can say so', () => {
    const cut = [msg('user', 'go', { id: 'u1' }), msg('assistant', 'half a th', { id: 'a1', interrupted: true })];
    expect(recentTurns(cut, 2)[1].interrupted).toBe(true);
    expect(recentTurns(history, 2)[1].interrupted).toBeUndefined();
  });

  it('is empty for a chat nobody has said anything in', () => {
    expect(recentTurns([], 3)).toEqual([]);
    expect(recentTurns([msg('system', 'you are a cat')], 3)).toEqual([]);
  });
});
