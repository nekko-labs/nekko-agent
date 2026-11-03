import React from 'react';
import { describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ sessions: [] as any[], prStatus: true }));
vi.mock('../store.js', () => ({ useStore: Object.assign((selector: (state: unknown) => unknown) => selector({ openPrPane: () => {}, sessions: mock.sessions, settings: {} }), { getState: () => ({ pushToast: () => {} }) }) }));
vi.mock('../prPolling.js', () => ({ subscribePrPolling: () => () => {} }));
vi.mock('../simpleMode.js', () => ({ useShown: () => mock.prStatus }));
import { renderToStaticMarkup } from 'react-dom/server';
import { PrCard } from './PrCard.js';
import type { PrInfo } from '@nekko-agent/shared';

const url = 'https://github.com/o/r/pull/1';
describe('live PR card in the chat transcript', () => {
  it('renders status, progress and actions once a session hosts it', () => {
    mock.sessions = [{ id: 's', executionMode: 'worktree' }];
    const info = { url, owner: 'o', repo: 'r', number: 1, title: 'Hello', state: 'open', checks: 'pending', source: 'gh' } as PrInfo;
    const html = renderToStaticMarkup(<PrCard url={url} info={info} event="created" sessionId="s" />);
    expect(html).toContain('data-pr-actions');
    expect(html).toContain('Open</span>');
    expect(html).toContain('Approve');
    expect(html).toContain('Review');
    expect(html).toContain('data-pr-progress');
    mock.sessions = [];
  });
  it('stays a plain card when PR status is hidden', () => {
    mock.sessions = [{ id: 's', executionMode: 'worktree' }];
    mock.prStatus = false;
    const info = { url, owner: 'o', repo: 'r', number: 1, state: 'open', checks: 'pending', source: 'gh' } as PrInfo;
    const html = renderToStaticMarkup(<PrCard url={url} info={info} event="created" sessionId="s" />);
    expect(html).toContain('PR created');
    expect(html).not.toContain('data-pr-actions');
    mock.prStatus = true;
    mock.sessions = [];
  });
  it('offers continuation only for eligible chats and routes native stack merges to GitHub', () => {
    const info = { url, owner: 'o', repo: 'r', number: 1, state: 'open', checks: 'none', stack: { number: 2, size: 3 } } as unknown as PrInfo;
    mock.sessions = [{ id: 's', executionMode: 'worktree' }];
    const html = renderToStaticMarkup(<PrCard url={url} info={info} event="created" sessionId="s" />);
    expect(html).toContain('Continue as stacked PR');
    expect(html).toContain('Merge on GitHub');
    expect(html).toContain('GitHub stack');
    for (const patch of [{ executionMode: 'sandbox' }, { offline: true }, { incognito: true }]) {
      mock.sessions = [{ id: 's', ...patch }];
      expect(renderToStaticMarkup(<PrCard url={url} info={info} event="created" sessionId="s" />)).not.toContain('Continue as stacked PR');
    }
    mock.sessions = [];
  });
  it('does not go live without a session or when the PR is not open', () => {
    const info = { url, state: 'open', checks: 'none' } as PrInfo;
    expect(renderToStaticMarkup(<PrCard url={url} info={info} event="created" />)).not.toContain('data-pr-actions');
    const merged = { url, state: 'merged', checks: 'passing' } as PrInfo;
    expect(renderToStaticMarkup(<PrCard url={url} info={merged} event="created" sessionId="s" />)).not.toContain('data-pr-actions');
  });
});
