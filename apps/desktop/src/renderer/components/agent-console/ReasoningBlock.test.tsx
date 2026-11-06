import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('./rowState.js', () => ({ useRowState: (_key: string, value: unknown) => [value, vi.fn()] }));
import { ActivityGroup } from './ActivityGroup.js';
import { FoldThoughtsContext, ReasoningBlock } from './ReasoningBlock.js';

describe('inline thoughts', () => {
  it.each([false, true])('shows the complete thought and icon without disclosure (live=%s)', live => {
    const html = renderToStaticMarkup(<ReasoningBlock text="Check the smaller surface first." live={live} duration={2} />);
    expect(html).toContain('Check the smaller surface first.');
    expect(html).toContain('<svg');
    expect(html).toContain('data-chat-thought');
    expect(html).not.toContain('<button');
  });
  it.each([false, true])('keeps thoughts visible once in order around collapsed tools (streaming=%s)', streaming => {
    const html = renderToStaticMarkup(<ActivityGroup streaming={streaming} items={[
      { kind: 'reasoning', text: 'First thought', duration: 1 },
      { kind: 'tool', call: { id: 'read', name: 'read_file', input: { path: 'example.ts' } } },
      { kind: 'reasoning', text: 'Second thought', duration: null },
    ]} />);
    expect(html.match(/data-chat-thought/g)).toHaveLength(2);
    expect(html.match(/First thought/g)).toHaveLength(1);
    expect(html.indexOf('First thought')).toBeLessThan(html.indexOf('aria-expanded'));
    expect(html.indexOf('aria-expanded')).toBeLessThan(html.indexOf('Second thought'));
  });
});

// Intermediate frames, not just the final projection: each new thought is visible
// immediately, and repeated calls already have a purpose row before done.
it('renders thoughts and purpose groups at every live event boundary', () => {
  const items: any[] = [{ kind: 'reasoning', text: 'Inspect guidance now.', duration: null }];
  const html = () => renderToStaticMarkup(<ActivityGroup streaming items={[...items]} />);
  expect(html()).toContain('Inspect guidance now.');
  items.push({ kind: 'tool', call: { id: 'a', name: 'read_file', input: { path: 'AGENTS.md' } } });
  expect(html()).toContain('AGENTS.md');
  items.push({ kind: 'tool', call: { id: 'b', name: 'read_file', input: { path: 'CLAUDE.md' } } });
  expect(html()).toContain('data-purpose-group="guidance"');
  items.push({ kind: 'reasoning', text: 'Now inspect the source.', duration: null });
  expect(html()).toContain('Now inspect the source.');
  expect(html().match(/data-chat-thought/g)).toHaveLength(2);
});

describe('local thoughts fold once the answer starts', () => {
  const local = (node: React.ReactNode) => renderToStaticMarkup(<FoldThoughtsContext.Provider value>{node}</FoldThoughtsContext.Provider>);
  const items = [{ kind: 'reasoning' as const, text: 'Long raw deliberation.', duration: 4 }];

  it('stays live inline while thinking and no answer text has arrived', () => {
    const html = local(<ActivityGroup streaming items={items} />);
    expect(html).toContain('Long raw deliberation.');
    expect(html).not.toContain('<button');
  });
  it('folds to "Thought for Xs" when answer text begins (the group stops streaming)', () => {
    const html = local(<ActivityGroup streaming={false} turnRunning items={items} />);
    expect(html).toContain('Thought for 4s');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Long raw deliberation.');
  });
  it('loads saved local chats folded', () => {
    const html = local(<ReasoningBlock text="Saved deliberation." live={false} duration={3} />);
    expect(html).toContain('Thought for 3s');
    expect(html).not.toContain('Saved deliberation.');
  });
  it('leaves cloud reasoning inline and expanded', () => {
    const html = renderToStaticMarkup(<ActivityGroup streaming={false} items={items} />);
    expect(html).toContain('Long raw deliberation.');
    expect(html).not.toContain('<button');
  });
});
