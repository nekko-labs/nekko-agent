// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Markdown } from './Markdown.js';

const chipRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../store.js', () => ({ useStore: { getState: () => ({}) } }));
vi.mock('./ReplyRefChips.js', async (original) => ({
  ...await original<typeof import('./ReplyRefChips.js')>(),
  IssueRefChip: ({ children }: { children: React.ReactNode }) => { chipRenders.count += 1; return <>{children}</>; },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; chipRenders.count = 0; });

function mount(text: string, topics = false) {
  const el = document.createElement('div');
  root = createRoot(el);
  const set = (t: string) => act(() => root!.render(<Markdown text={t} topics={topics} />));
  set(text);
  return { el, set };
}

describe('streaming markdown', () => {
  it('does not re-render a finished block when a delta lands in the last one', () => {
    const { set } = mount('First block fixed in #123.\n\nSecond block');
    expect(chipRenders.count).toBe(1);
    set('First block fixed in #123.\n\nSecond block grows');
    set('First block fixed in #123.\n\nSecond block grows more');
    expect(chipRenders.count).toBe(1);
  });

  it('keeps finished blocks still with topics on, where evidence is derived from the whole text', () => {
    const { set } = mount('Done in #7.\n\nNext', true);
    expect(chipRenders.count).toBe(1);
    set('Done in #7.\n\nNext step');
    set('Done in #7.\n\nNext step and more');
    expect(chipRenders.count).toBe(1);
  });

  it('re-renders a block whose own source changed', () => {
    const { set } = mount('Fixed in #123');
    set('Fixed in #123, and #124');
    expect(chipRenders.count).toBeGreaterThan(1);
  });

  it('shows a mermaid fence as code while it is open and as a diagram once it closes', () => {
    const open = 'Intro\n\n```mermaid\ngraph TD\n  A-->B';
    const { el, set } = mount(open);
    expect(el.querySelector('[data-code-block]')?.textContent).toContain('graph TD');
    set(`${open}\n\`\`\`\n`);
    expect(el.querySelector('[data-code-block]')).toBeNull();
  });
});
