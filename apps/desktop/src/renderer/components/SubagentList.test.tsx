import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PrInfo, SessionSummary } from '@nekko-agent/shared';
const state = vi.hoisted(() => ({
  providers: [{ id: 'local', label: 'LM Studio' }],
  prsBySession: {} as Record<string, PrInfo[]>,
}));
vi.mock('../store.js', () => ({ useStore: (selector: (state: unknown) => unknown) => selector(state) }));
vi.mock('../useGitStatus.js', () => ({ useGitStatus: () => null }));
import { SubagentList } from './SubagentList.js';

const children = Array.from({ length: 4 }, (_, i) => ({ id: `k${i}`, title: `Task ${i}`, providerId: 'local', modelId: 'community/Qwen3-32B:latest' })) as SessionSummary[];
const render = (kids = children, expandByDefault = false) => renderToStaticMarkup(<SubagentList children={kids} statuses={new Map()} expandByDefault={expandByDefault} onOpen={() => {}} />);

describe('sub-agent done check', () => {
  const one = [children[0]];
  const row = (status: 'done' | 'working') => renderToStaticMarkup(<SubagentList children={one} statuses={new Map([['k0', status]])} expandByDefault={false} onOpen={() => {}} />);

  it('trails a done row, after its text, and leaves nothing before the title', () => {
    const html = row('done');
    const at = (needle: string) => html.indexOf(needle);
    expect(html.match(/aria-label="Done"/g)).toHaveLength(1);
    expect(at('aria-label="Done"')).toBeGreaterThan(at('Task 0'));
    expect(at('aria-label="Done"')).toBeGreaterThan(at('Qwen3-32B'));
    expect(html).toMatch(/data-subagent-tree="last" class="subagent-tree"><\/span><span class="min-w-0 flex-1">/);
  });
  it('keeps the other glyphs where they are, before the title', () => {
    const html = row('working');
    expect(html).toContain('aria-label="Working"');
    expect(html.indexOf('aria-label="Working"')).toBeLessThan(html.indexOf('Task 0'));
  });
});

describe('compact subagent tree', () => {
  it('shows the first two and hides the extra region from keyboard and assistive technology by default', () => {
    const html = render();
    const [visible, hidden] = html.split('collapse-wrap');
    expect(visible.match(/data-subagent-row=/g)).toHaveLength(2);
    expect(hidden.match(/data-subagent-row=/g)).toHaveLength(2);
    expect(hidden).toContain('collapsed');
    expect(hidden).toContain('inert="" aria-hidden="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls=');
    expect(html).toContain('Show more (2)');
    expect(visible).toContain('data-subagent-tree="last"');
  });
  it('starts fully expanded with the saved preference, retaining a collapse control', () => {
    const html = render(children, true);
    expect(html).not.toContain('inert=""');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Show less');
    expect(html.match(/data-subagent-tree="last"/g)).toHaveLength(1);
  });
  it('shows the persisted provider/model below a strong title, not a guessed parent route', () => {
    const html = render();
    expect(html).toContain('Qwen3-32B · LM Studio');
    expect(html).toContain('title="LM Studio · community/Qwen3-32B:latest"');
    expect(html).toContain('data-subagent-title="true"');
  });
  it('has no disclosure for zero, one, or two children and handles missing identities', () => {
    expect(render([])).toBe('');
    for (const count of [1, 2]) expect(render(children.slice(0, count))).not.toContain('data-subagent-toggle');
    const html = render([{ id: 'missing', title: '' } as SessionSummary]);
    expect(html).toContain('Untitled chat');
    expect(html).not.toContain('data-subagent-route');
  });
  it('carries a PR chip on the row whose chat has mentioned PRs', () => {
    state.prsBySession = {
      k1: [{
        owner: 'nekko-labs',
        repo: 'nekko-agent',
        number: 42,
        url: 'https://github.com/nekko-labs/nekko-agent/pull/42',
        title: 'Add a pretty thing',
        state: 'open',
        isDraft: false,
        createdAt: '2026-11-15T10:00:00Z',
      } as PrInfo],
    };
    try {
      const html = render();
      expect(html).toContain('data-session-pr-chip');
      expect(html).toContain('#42');
      expect(html).toContain('data-pr-status="open"');
    } finally {
      state.prsBySession = {};
    }
  });
});
