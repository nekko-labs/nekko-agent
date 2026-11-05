import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@nekko-agent/shared';
import { CompactionSummary } from './CompactionSummary.js';

vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));

const message = { id: 'summary', role: 'system', content: 'Private summary body', createdAt: 1793757600000, compaction: { summarized: 198 } } as ChatMessage;
describe('CompactionSummary', () => {
  for (const latest of [true, false]) {
    it(`starts ${latest ? 'latest' : 'earlier'} compaction collapsed without rendering the summary`, () => {
      const html = renderToStaticMarkup(<CompactionSummary message={message} latest={latest} />);
      expect(html).toContain('Conversation compacted');
      expect(html).toContain('198 earlier messages summarized');
      expect(html).toContain('aria-expanded="false"');
      expect(html).toContain('aria-controls=');
      expect(html).toContain('Show summary');
      expect(html).not.toContain(message.content);
      expect(html).not.toContain('role="separator"');
    });
  }
  it('handles one summarized message and missing metadata', () => {
    expect(renderToStaticMarkup(<CompactionSummary message={{ ...message, compaction: { ...message.compaction!, summarized: 1 } }} latest />)).toContain('1 earlier message summarized');
    expect(renderToStaticMarkup(<CompactionSummary message={{ ...message, compaction: undefined }} latest />)).toContain('Earlier conversation summarized');
  });
});
