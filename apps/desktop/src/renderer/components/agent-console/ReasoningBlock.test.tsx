import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('./rowState.js', () => ({ useRowState: (_key: string, value: unknown) => [value, vi.fn()] }));
import { ActivityGroup } from './ActivityGroup.js';
import { ReasoningBlock } from './ReasoningBlock.js';

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
