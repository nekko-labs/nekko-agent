import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, MarkdownSandbox, MarkdownSession } from './Markdown.js';
vi.mock('../store.js', () => ({ useStore: { getState: () => ({}) } }));
const pair = '![Before: Navbar](/tmp/b.png)\n![After: Navbar](/tmp/a.png)';
const reply = pair + '\n\n**Next step**\nReview the screenshots.';
describe('verification screenshot placement', () => {
  it('shows the original pair and mirrors it under Next step', () => {
    const out = renderToStaticMarkup(<MarkdownSession.Provider value="origin"><Markdown text={reply} topics /></MarkdownSession.Provider>);
    expect(out.match(/data-verification-evidence="inline"/g)).toHaveLength(1);
    expect(out.match(/data-verification-evidence="next-step"/g)).toHaveLength(1);
    expect(out.indexOf('data-topic="next"')).toBeLessThan(out.indexOf('data-verification-evidence="next-step"'));
    expect(out).toContain('does not mean it has been inspected or approved');
  });
  it('does not inject panels into user messages, documents or incomplete pairs', () => {
    expect(renderToStaticMarkup(<Markdown text={reply} />)).not.toContain('data-verification-evidence');
    expect(renderToStaticMarkup(<Markdown text={reply} doc />)).not.toContain('data-verification-evidence');
    expect(renderToStaticMarkup(<Markdown text={'![After: New](/tmp/a.png)\n\n**Next step**'} topics />)).not.toContain('data-verification-evidence');
  });
  it('retains Sandbox host-read restrictions in both placements', () => {
    const out = renderToStaticMarkup(<MarkdownSandbox.Provider value><Markdown text={reply} topics /></MarkdownSandbox.Provider>);
    expect(out.match(/Host image previews are unavailable in Sandbox/g)).toHaveLength(4);
    expect(out).not.toContain('<img');
  });
});
