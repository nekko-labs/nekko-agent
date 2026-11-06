import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
import { FoldThoughtsContext, ReasoningBlock } from './ReasoningBlock.js';
import { RowKeyContext, RowMemoryContext } from './rowState.js';

describe('folded thought expansion', () => {
  it('reopens a message expanded when the person expanded it before', () => {
    const memory = new Map<string, unknown>([['msg-1:thought-open', true]]);
    const html = (row: string) => renderToStaticMarkup(
      <FoldThoughtsContext.Provider value><RowMemoryContext.Provider value={memory}><RowKeyContext.Provider value={row}>
        <ReasoningBlock text="Remembered deliberation." live={false} duration={2} />
      </RowKeyContext.Provider></RowMemoryContext.Provider></FoldThoughtsContext.Provider>,
    );
    expect(html('msg-1')).toContain('aria-expanded="true"');
    expect(html('msg-1')).toContain('Remembered deliberation.');
    expect(html('msg-2')).not.toContain('Remembered deliberation.');
  });
});
