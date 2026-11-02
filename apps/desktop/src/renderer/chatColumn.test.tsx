import { beforeEach, describe, expect, it, vi } from 'vitest';
import './tests/browserGlobals.js';
import { cssRule, stylesheet } from './tests/css.js';
import { liveStore } from './tests/liveStore.js';
import { chatSession, renderChatPane, withProvider } from './tests/renderChatPane.js';

vi.mock('./store.js', (original) => liveStore(original as never));
vi.mock('./liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));

const css = stylesheet('styles.css');
beforeEach(() => withProvider());

describe('chat reply column', () => {
  it('puts the transcript in one centred column at the prose measure', () => {
    const html = renderChatPane(chatSession({ messages: [
      { id: 'u', role: 'user', content: 'A question', createdAt: 1 },
      { id: 'a', role: 'assistant', content: 'Some prose.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |', createdAt: 2 },
    ] as never }));
    const scroller = html.slice(html.indexOf('data-transcript-scroll'));
    const column = scroller.match(/<div[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(column.split(' ')).toEqual(expect.arrayContaining(['chat-column', 'mx-auto', 'w-full']));
  });

  it('caps the column where reply prose stops, so tables and code end at the same edge', () => {
    // Prose stops at 68ch of its own text-sm (14px); the column inherits
    // text-base (16px), so it needs the same 68 characters scaled by 14/16.
    expect(cssRule(css, ':is(.msg-ai, .md-doc) :is(p, ul, ol, blockquote, h1, h2, h3, h4, h5, h6)')['max-width']).toBe('68ch');
    expect(cssRule(css, '.chat-column')['max-width']).toBe('calc(68ch * 14 / 16)');
  });
});
