import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@nekko-agent/shared';
import { cutPrompt, messageCuts } from './messageCut.js';

const m = (id: string, role: ChatMessage['role'], content = id, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, content, createdAt: 0, ...extra });

describe('messageCuts', () => {
  const chat = [
    m('u1', 'user'),
    m('a1', 'assistant', 'thinking about it', { toolCalls: [{ id: 'c', name: 'read_file', input: {} }] }),
    m('t1', 'tool', '', { toolResult: { toolCallId: 'c', output: 'x' } }),
    m('a2', 'assistant', 'first answer'),
    m('u2', 'user', 'what file type?', { images: ['data:image/png;base64,AA'] }),
    m('a3', 'assistant', 'second answer'),
  ];

  it('restarts from the last reply of each turn that has something after it', () => {
    const { restart } = messageCuts(chat);
    expect([...restart.keys()]).toEqual(['a2']);
    expect(restart.get('a2')).toEqual({ from: 'u2', removed: 2 });
  });

  it('deletes the latest user message with the reply it got', () => {
    expect(messageCuts(chat).deleteLast).toEqual({ id: 'u2', cut: { from: 'u2', removed: 2 } });
    // A failed turn left only the message itself.
    expect(messageCuts(chat.slice(0, 5)).deleteLast).toEqual({ id: 'u2', cut: { from: 'u2', removed: 1 } });
  });

  it('does not reach behind a compaction summary', () => {
    const compacted = [...chat.slice(0, 4), m('s', 'assistant', 'summary', { compaction: { summarized: 4 } }), m('a9', 'assistant', 'after')];
    const cuts = messageCuts(compacted);
    expect(cuts.deleteLast).toBeNull();
    expect(cuts.restart.size).toBe(0);
  });

  it('offers nothing for an empty chat', () => {
    expect(messageCuts([])).toEqual({ restart: new Map(), deleteLast: null });
  });

  it('says what a click removes', () => {
    expect(cutPrompt('delete', { from: 'u', removed: 1 })).toBe("Delete your last message? This can't be undone.");
    expect(cutPrompt('delete', { from: 'u', removed: 2 })).toMatch(/and the reply after it/);
    expect(cutPrompt('delete', { from: 'u', removed: 4 })).toMatch(/and the 3 messages after it/);
    expect(cutPrompt('restart', { from: 'u', removed: 2 })).toMatch(/The 2 messages after it will be deleted/);
  });
});
