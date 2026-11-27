import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatWithHeld, getHeld, hasHeld, heldReadyToApply, holdChoice, isUnsent, takeHeld } from './chatGroupHold.js';
import { ChatGroupTagButton } from './ChatGroupTagControls.js';
import { useStore } from '../store.js';

const clear = () => { ['a', 'b', 'new'].forEach(takeHeld); };

describe('held group and tags for a chat with no messages', () => {
  beforeEach(clear);
  afterEach(clear);

  it('holds while there are no messages: nothing is saved and the chat reads the held choice', () => {
    const saved = { chatGroup: null, tags: [] as string[] };
    holdChoice('a', { chatGroup: 'g_be' });
    holdChoice('a', { tags: ['test', 'nc1'] });
    expect(getHeld('a')).toEqual({ chatGroup: 'g_be', tags: ['test', 'nc1'] });
    expect(chatWithHeld('a', saved, true)).toMatchObject({ chatGroup: 'g_be', tags: ['test', 'nc1'], exists: true });
    // The saved copy the sidebar and breadcrumb read is untouched.
    expect(saved).toEqual({ chatGroup: null, tags: [] });
    // Without the hold (sidebar picker) the saved value shows.
    expect(chatWithHeld('a', saved, false).chatGroup).toBeNull();
  });

  it('is unsent until a message exists', () => {
    expect(isUnsent(undefined)).toBe(true);
    expect(isUnsent({ messageCount: 0 })).toBe(true);
    expect(isUnsent({ messageCount: 1 })).toBe(false);
  });

  it('applies only after the first send, once', () => {
    holdChoice('a', { chatGroup: 'g_be', tags: ['x'] });
    expect(heldReadyToApply(['a'], [{ id: 'a', messageCount: 0 }])).toEqual([]);
    expect(heldReadyToApply(['a'], [])).toEqual([]);
    expect(heldReadyToApply(['a'], [{ id: 'a', messageCount: 1 }])).toEqual(['a']);
    expect(takeHeld('a')).toEqual({ chatGroup: 'g_be', tags: ['x'] });
    expect(heldReadyToApply(['a'], [{ id: 'a', messageCount: 1 }])).toEqual([]);
  });

  it('does not leak to another new chat, and is dropped on discard', () => {
    holdChoice('a', { chatGroup: 'g_be' });
    expect(chatWithHeld('b', { messageCount: 0 } as never, true).chatGroup).toBeUndefined();
    expect(heldReadyToApply(['b'], [{ id: 'b', messageCount: 1 }])).toEqual([]);
    takeHeld('a');
    expect(hasHeld('a')).toBe(false);
  });

  it('the composer button shows the held choice and saves nothing', () => {
    useStore.setState({ sessions: [{ id: 'a', title: 'New chat', messageCount: 0, createdAt: 0, updatedAt: 0 } as never] });
    holdChoice('a', { tags: ['x', 'y'] });
    expect(renderToStaticMarkup(<ChatGroupTagButton sessionId="a" />)).toContain('#2');
    expect(useStore.getState().sessions[0]).not.toHaveProperty('tags');
  });
});
