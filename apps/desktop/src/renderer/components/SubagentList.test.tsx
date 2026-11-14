import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@nekko-agent/shared';
const state = vi.hoisted(() => ({ providers: [{ id: 'local', label: 'LM Studio' }] }));
vi.mock('../store.js', () => ({ useStore: (selector: (state: unknown) => unknown) => selector(state) }));
import { SubagentList } from './SubagentList.js';

const children = Array.from({ length: 4 }, (_, i) => ({ id: `k${i}`, title: `Task ${i}`, providerId: 'local', modelId: 'community/Qwen3-32B:latest' })) as SessionSummary[];
const render = (kids = children, expandByDefault = false) => renderToStaticMarkup(<SubagentList children={kids} statuses={new Map()} expandByDefault={expandByDefault} onOpen={() => {}} />);

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
    expect(html).toContain('data-subagent-title="true" class="block truncate font-semibold text-ink"');
  });
  it('has no disclosure for zero, one, or two children and handles missing identities', () => {
    expect(render([])).toBe('');
    for (const count of [1, 2]) expect(render(children.slice(0, count))).not.toContain('data-subagent-toggle');
    const html = render([{ id: 'missing', title: '' } as SessionSummary]);
    expect(html).toContain('Untitled chat');
    expect(html).not.toContain('data-subagent-route');
  });
});
