import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ sessions: [{ id: 'parent', title: 'Mobile Agent Attention Notifications' }] as unknown[] }));
vi.mock('../store.js', () => ({ useStore: (selector: (state: unknown) => unknown) => selector(state) }));
import { SubagentBanner } from './SubagentBanner.js';

describe('SubagentBanner', () => {
  it('says the chat is a sub-agent and names the chat that spawned it', () => {
    const html = renderToStaticMarkup(<SubagentBanner parentId="parent" onOpenParent={() => {}} />);
    expect(html).toContain('aria-label="Sub-agent of Mobile Agent Attention Notifications"');
    expect(html).toContain('title="Open Mobile Agent Attention Notifications"');
  });
  it('still reads as a sub-agent when the parent is not in the list', () => {
    expect(renderToStaticMarkup(<SubagentBanner parentId="gone" onOpenParent={() => {}} />)).toContain('Sub-agent of its parent chat');
  });
});
