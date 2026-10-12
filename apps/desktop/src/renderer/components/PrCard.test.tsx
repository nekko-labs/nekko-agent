import React from 'react';
import { describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ sessions: [] as any[] }));
vi.mock('../store.js', () => ({ useStore: (selector: (state: unknown) => unknown) => selector({ openPrPane: () => {}, sessions: mock.sessions }) }));
vi.mock('../prPolling.js', () => ({ subscribePrPolling: () => () => {} }));
import { renderToStaticMarkup } from 'react-dom/server';
import { PrActionDock } from './PrCard.js';
import type { PrInfo } from '@nekko-agent/shared';

const url = 'https://github.com/o/r/pull/1';
describe('composer PR deck', () => {
  it('renders a slim expandable deck for chat-created PRs', () => {
    const html = renderToStaticMarkup(<PrActionDock sessionId="test" urls={[url]} prs={[]} />);
    expect(html).toContain('pr-action-deck');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('1 pull request');
    expect(html).toContain('Tuck away');
    expect(html).toContain('Review');
    expect(html).toContain('Hide PR o/r#1');
  });
  it('does not resurrect cached references', () => {
    expect(renderToStaticMarkup(<PrActionDock sessionId="test" urls={[]} prs={[{ url, state: 'open' } as PrInfo]} />)).toBe('');
  });
  it('keeps merged PRs as a collapsed summary without actions', () => {
    const html = renderToStaticMarkup(<PrActionDock sessionId="test" urls={[url]} prs={[{ url, state: 'merged' } as PrInfo]} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Merged');
    expect(html).not.toContain('data-pr-actions');
  });
  it('offers continuation only for eligible chats and routes native stack merges to GitHub', () => {
    mock.sessions = [{ id: 'test', executionMode: 'worktree' }];
    const info = { url, state: 'open', checks: 'none', stack: { number: 2, size: 3 } } as PrInfo;
    const html = renderToStaticMarkup(<PrActionDock sessionId="test" urls={[url]} prs={[info]} />);
    expect(html).toContain('Continue as stacked PR');
    expect(html).toContain('Merge on GitHub');
    expect(html).toContain('GitHub stack');
    for (const patch of [{ executionMode: 'sandbox' }, { offline: true }, { incognito: true }]) {
      mock.sessions = [{ id: 'test', ...patch }];
      expect(renderToStaticMarkup(<PrActionDock sessionId="test" urls={[url]} prs={[info]} />)).not.toContain('Continue as stacked PR');
    }
    mock.sessions = [];
  });
});
