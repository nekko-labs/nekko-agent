import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@nekko-agent/shared';
import { unsavedPrompt, withUnsavedPrompt } from './unsavedPrompt.js';

const msg = (id: string, role: ChatMessage['role'], content: string, createdAt: number): ChatMessage => ({ id, role, content, createdAt });

describe('unsavedPrompt', () => {
  const sent = msg('tmp', 'user', 'go ahead', 10_000_000);
  const reply = msg('a1', 'assistant', 'The split is underway', 9_000_000);

  it('keeps a sent prompt the saved chat does not have yet', () => {
    // A re-read while the turn waits for Claude Code: the optimistic copy is gone.
    expect(unsavedPrompt([reply], sent)).toBe(sent);
    // The pane's own copy is not the saved one.
    expect(unsavedPrompt([reply, sent], sent)).toBe(sent);
  });

  it('lets the saved prompt take its place', () => {
    expect(unsavedPrompt([reply, msg('u2', 'user', 'go ahead', sent.createdAt + 5)], sent)).toBeNull();
    // The engine's clock may trail the window's a little.
    expect(unsavedPrompt([reply, msg('u2', 'user', 'go ahead', sent.createdAt - 2_000)], sent)).toBeNull();
  });

  it('is not fooled by the same words sent long before', () => {
    expect(unsavedPrompt([msg('u0', 'user', 'go ahead', 1_000), reply], sent)).toBe(sent);
  });

  it('is nothing when nothing was sent', () => {
    expect(unsavedPrompt([reply], null)).toBeNull();
  });
});

describe('withUnsavedPrompt', () => {
  const sent = msg('tmp', 'user', 'go ahead', 2);
  const reply = msg('a1', 'assistant', 'done', 1);

  it('puts the prompt back last when the live turn cut it off', () => {
    expect(withUnsavedPrompt([reply], sent)).toEqual([reply, sent]);
  });

  it('never shows it twice', () => {
    const shown = [reply, sent];
    expect(withUnsavedPrompt(shown, sent)).toBe(shown);
    expect(withUnsavedPrompt([reply], null)).toEqual([reply]);
  });
});
