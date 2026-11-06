import { beforeEach, describe, expect, it, vi } from 'vitest';
import './tests/browserGlobals.js';
import { cssRule, resolvedSelectors, stylesheet } from './tests/css.js';
import { liveStore } from './tests/liveStore.js';
import { chatSession, renderChatPane, withProvider } from './tests/renderChatPane.js';

vi.mock('./store.js', (original) => liveStore(original as never));
vi.mock('./liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));

const css = stylesheet('styles.css');
beforeEach(() => withProvider());

describe('chat reply width', () => {
  it('runs the transcript column the full pane width', () => {
    const html = renderChatPane(chatSession({ messages: [
      { id: 'u', role: 'user', content: 'A question', createdAt: 1 },
      { id: 'a', role: 'assistant', content: 'Some prose.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |', createdAt: 2 },
    ] as never }));
    const scroller = html.slice(html.indexOf('data-transcript-scroll'));
    const column = (scroller.match(/<div[^>]*class="([^"]*)"/)?.[1] ?? '').split(' ');
    expect(column).toEqual(expect.arrayContaining(['mx-auto', 'w-full']));
    expect(column.filter((c) => c.startsWith('max-w') || c === 'chat-column')).toEqual([]);
  });

  it('does not stop reply prose short of the tables and code beside it', () => {
    // A reply's paragraphs, lists, quotes and headings wrap at the column edge,
    // where its tables and code blocks end, not at a narrower measure.
    const capped: string[] = [];
    css.walkDecls('max-width', (decl) => {
      const rule = decl.parent as Parameters<typeof resolvedSelectors>[0];
      if (rule.type === 'rule' && resolvedSelectors(rule).some((s) => s.includes('.msg-ai'))) capped.push(`${rule.selector} { max-width: ${decl.value} }`);
    });
    expect(capped).toEqual([]);
  });

  it('keeps the readable measure for documents', () => {
    expect(cssRule(css, '.md-doc :is(p, ul, ol, blockquote, h1, h2, h3, h4, h5, h6)')['max-width']).toBe('68ch');
  });
});
