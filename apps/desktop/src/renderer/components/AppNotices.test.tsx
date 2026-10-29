import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppNotice } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { AppNotices, NoticeCard } from './AppNotices.js';

// The notice nekkod writes when it retires a Claude plan sign-in (claude_plan.rs).
const claudeNotice: AppNotice = {
  id: 'claude-sign-in-changed',
  title: 'Claude sign-in has changed',
  body: "To follow Anthropic's terms, Nekko Agent no longer signs in to Claude plans directly, and we've deleted the saved Claude sign-in from this computer. Your chats are safe.",
  points: [
    'Keep using your plan: choose Claude, then Subscription, which runs your installed Claude Code.',
    'Get every feature: add an Anthropic API key or cloud account.',
  ],
  actions: [
    { id: 'connect-claude-agent', label: 'Use my subscription' },
    { id: 'add-api-key', label: 'Add API key' },
    { id: 'what-changed', label: 'What changed?' },
  ],
  createdAt: 1,
};

describe('app notices', () => {
  it('shows nothing without a notice', () => {
    // Server rendering reads the store's initial state, which has no settings.
    expect(renderToStaticMarkup(<AppNotices />)).toBe('');
  });

  it('shows the Claude sign-in notice with its points and all three actions', () => {
    const html = renderToStaticMarkup(<NoticeCard notice={claudeNotice} />);
    expect(html).toContain('Claude sign-in has changed');
    expect(html).toContain('Your chats are safe.');
    expect(html).toContain('choose Claude, then Subscription');
    for (const label of ['Use my subscription', 'Add API key', 'What changed?', 'Dismiss']) expect(html).toContain(label);
    expect(html).toContain('role="status"');
  });

  it('makes the first action the primary one', () => {
    const html = renderToStaticMarkup(<NoticeCard notice={claudeNotice} />);
    expect(html.indexOf('btn btn-primary')).toBeLessThan(html.indexOf('Use my subscription'));
    expect((html.match(/btn btn-primary/g) ?? []).length).toBe(1);
  });

  it('opens Add provider on the kind a notice action asks for', () => {
    useStore.setState({ view: 'command', addProviderKind: null, settings: {} as never });
    useStore.getState().openAddProvider('claude-code');
    expect(useStore.getState().addProviderKind).toBe('claude-code');
    expect(useStore.getState().view).toBe('models');
  });
});
