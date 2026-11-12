import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, markdownSegments, renderWhole, safeHref, linkContextActions } from './Markdown.js';

const browser = vi.hoisted(() => vi.fn());
vi.mock('../store.js', () => ({ useStore: { getState: () => ({ openBrowserPane: browser }) } }));

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('topics', () => {
  const topics = (text: string, askTail = false) => renderToStaticMarkup(<Markdown text={text} topics askTail={askTail} />);

  it('draws a named topic as a header, with the words after the label under it', () => {
    const out = topics('**Next step**: merge it\nonce CI is green.');
    expect(out).toContain('data-topic="next"');
    expect(out).toContain('role="heading"');
    expect(out).not.toContain('<strong>');
    expect(out).toMatch(/Next step<\/div><p[^>]*>merge it<br\/>once CI is green\.<\/p>/);
  });

  it('reads headings and keeps the block after them', () => {
    const out = topics('## Open questions\n\n- Which one?');
    expect(out).toContain('data-topic="question"');
    expect(out).toContain('<li');
  });

  it('leaves other text, code and untagged Markdown as they were', () => {
    expect(topics('## Installation\n\n**Important**: read this.')).not.toContain('data-topic');
    expect(topics('```md\n**Next step**: in a fence\n```')).not.toContain('data-topic');
    expect(html('**Next step**: a user typed this')).not.toContain('data-topic');
  });

  it('gives a closing question its header only when asked, and only once', () => {
    expect(topics('All green.\n\nOpen the PR?')).not.toContain('data-topic');
    const out = topics('All green.\n\nOpen the PR?', true);
    expect(out.match(/data-topic="question"/g)).toHaveLength(1);
    expect(out.indexOf('All green.')).toBeLessThan(out.indexOf('data-topic'));
    expect(topics('**Question**\n\nOpen the PR?', true).match(/data-topic=/g)).toHaveLength(1);
  });
});

describe('file:// links', () => {
  it('open the decoded local path in the file pane, and network shares stay inert', () => {
    expect(html('[Report](file:///C:/My%20Docs/report.md)')).toContain('title="Open C:/My Docs/report.md"');
    expect(html('[Notes](file:///home/me/notes.md)')).toContain('title="Open /home/me/notes.md"');
    const share = html('[Share](file://server/share/a.md)');
    expect(share).not.toContain('<button');
    expect(share).not.toContain('href=');
  });
});

describe('remote images', () => {
  it('render as host-loaded cards, never as a remote <img src>', () => {
    const out = html('Here it is:\n\n![Wall mount](https://hamilex.example/a.jpeg)');
    expect(out).toContain('data-remote-image="https://hamilex.example/a.jpeg"');
    expect(out).not.toMatch(/<img[^>]+src="https?:/);
    expect(out).toContain('Wall mount');
  });
  it('group lines of nothing but photos into one gallery', () => {
    const out = html('![a](https://x.example/1.png)\n![b](https://x.example/2.png) ![c](https://x.example/3.png)');
    expect(out).toContain('aria-label="3 photos"');
    expect(out.match(/data-remote-image=/g)).toHaveLength(3);
  });
  it('keep a lone photo, or photos inside prose, inline', () => {
    expect(html('![a](https://x.example/1.png)')).not.toContain('photos"');
    expect(html('Look ![a](https://x.example/1.png) and ![b](https://x.example/2.png)')).not.toContain('photos"');
  });
  it('refuse non-http schemes', () => {
    const out = html('![x](javascript:alert(1)) ![y](data:image/svg+xml,<svg/onload=alert(1)>)');
    expect(out).not.toContain('data-remote-image');
    expect(out).not.toContain('<img');
  });
});

describe('Markdown', () => {
  it('normalizes link targets and encodes HTML metacharacters from edited DOM text', () => {
    const target = 'https://example.com/?label=<img src=x onerror=alert(1)>&quote="\'`';
    const safe = safeHref(target);
    expect(safe).not.toBeNull();
    expect(safe).not.toMatch(/[<>"'`]/);
    const out = html(`[safe](${target.replace(/ /g, '%20')})`);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
  });
  it('routes safe link menu actions to external browser, in-app browser and clipboard', () => {
    const openPath = vi.fn();
    const writeText = vi.fn();
    vi.stubGlobal('window', { nekko: { openPath } });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      const url = 'https://github.com/nekko-labs/nekko-agent/pull/309';
      const actions = linkContextActions(url);
      expect(actions.map((a) => a.label)).toEqual(['Open in external browser', 'Open in in-app browser', 'Copy link']);
      actions.forEach((a) => a.run());
      expect(openPath).toHaveBeenCalledWith(url);
      expect(browser).toHaveBeenCalledWith(url);
      expect(writeText).toHaveBeenCalledWith(url);
      expect(linkContextActions('javascript:alert(1)')).toEqual([]);
      expect(linkContextActions('mailto:test@example.com').map((a) => a.label)).not.toContain('Open in in-app browser');
    } finally { vi.unstubAllGlobals(); }
  });
  it('offers a live web preview without loading any remote frame before a click', () => {
    const out = html('[Spinner](https://css-loaders.com/spinner/) and [mail](mailto:hi@example.com)');
    expect(out).toContain('href="https://css-loaders.com/spinner/"');
    expect(out).toContain('aria-expanded="false">Preview</button>');
    expect(out).not.toContain('<iframe');
    expect(out.match(/>Preview<\/button>/g)).toHaveLength(1);
    expect(html('[bad](javascript:alert(1))')).not.toContain('>Preview</button>');
  });
  it('keeps document links free of chat-only preview controls', () => {
    const out = renderToStaticMarkup(<Markdown text="[Guide](https://example.com)" doc />);
    expect(out).not.toContain('>Preview</button>');
  });
  it('renders the reported GitHub PR reply as a labeled link', () => {
    const out = html('Yes—the GitHub integration is in [PR #309](https://github.com/nekko-labs/nekko-agent/pull/309). It’s an open draft with passing checks, not merged or verified against a live GitHub installation.');
    expect(out).toContain('href="https://github.com/nekko-labs/nekko-agent/pull/309"');
    expect(out).not.toContain('[PR #309]');
  });
  it('draws PR links as status chips, without a site preview', () => {
    const out = html('Merged in [#1663](https://github.com/nekko-labs/nekko-agent/pull/1663) and https://github.com/nekko-labs/nekko-agent/pull/1662');
    expect(out.match(/class="pr-link-chip /g)).toHaveLength(2);
    expect(out).toContain('data-pr-status="unknown"');
    expect(out).toContain('>#1663</span>');
    expect(out).toContain('>nekko-agent#1662</span>');
    expect(out).not.toContain('>Preview</button>');
    expect(html('[issue](https://github.com/nekko-labs/nekko-agent/issues/12)')).toContain('>Preview</button>');
  });
  it('shows a pointer over every chat link, file links included', () => {
    const out = html('[site](https://example.com) and [#1](https://github.com/a/b/pull/1)');
    expect(out.match(/cursor-pointer/g)).toHaveLength(2);
    const file = renderToStaticMarkup(<Markdown text="[completionExit.ts](C:\\repo\\completionExit.ts)" />);
    expect(file).toMatch(/<button type="button" class="[^"]*cursor-pointer/);
  });
  it('renders links nested inside emphasis without losing surrounding links', () => {
    const out = html('**[PR #309](https://github.com/nekko-labs/nekko-agent/pull/309)** and *[docs](https://example.com/docs)* then [next](https://example.com/next)');
    expect(out.match(/href=/g)).toHaveLength(3);
    expect(out).not.toContain('[PR #309]');
  });

  it('turns a dashed run glued to a sentence into a real list', () => {
    // The shape people actually type into the composer: a lead-in line with no
    // blank line before the dashes.
    const out = html('Nekko Agent project.\n- first thing\n- second thing');
    expect(out).toContain('<p dir="auto">Nekko Agent project.</p>');
    expect(out.match(/<li dir="auto">/g)).toHaveLength(2);
    expect(out).toContain('<li dir="auto">first thing</li>');
    expect(out).toContain('list-style-type:disc');
  });

  it('nests deeper-indented items under the item above', () => {
    const out = html('- top\n  - child\n  - sibling\n- next top');
    expect(out).toContain('list-style-type:circle');
    // One outer list with two top-level items, one inner list with two.
    expect(out.match(/<ul/g)).toHaveLength(2);
    expect(out.match(/<li dir="auto">/g)).toHaveLength(4);
  });

  it('keeps single newlines inside a paragraph as line breaks', () => {
    expect(html('one\ntwo')).toContain('one<br/>two');
  });

  it('starts a new list when a numbered run follows a bulleted one', () => {
    const out = html('- bullet\n1. number');
    expect(out).toContain('<ul');
    expect(out).toContain('<ol');
  });

  it('renders numbered lists, headings, quotes and rules', () => {
    expect(html('1. first\n2. second')).toContain('<ol');
    expect(html('## Heading')).toContain('Heading');
    expect(html('> quoted')).toContain('<blockquote');
    expect(html('---')).toContain('<hr');
  });

  it('renders a pipe table with a body', () => {
    const out = html('| Item | Count |\n| --- | --- |\n| Alpha | 1 |');
    expect(out).toContain('<table');
    expect(out).toContain('<th');
    expect(out).toContain('Alpha');
  });

  it('renders fenced code without treating its contents as markdown', () => {
    const out = html('```ts\n- not a bullet\n```');
    expect(out).toContain('<pre');
    expect(out).toContain('- not a bullet');
    expect(out).not.toContain('<li');
  });

  it('covers inline bold, italic, strike, code and links', () => {
    const out = html('**b** *i* ~~s~~ `c` [text](https://nekkoagent.com)');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<em>i</em>');
    expect(out).toContain('>s</s>');
    expect(out).toContain('>c</code>');
    expect(out).toContain('href="https://nekkoagent.com"');
  });

  it('auto-links a bare url', () => {
    expect(html('see https://nekkoagent.com now')).toContain('href="https://nekkoagent.com"');
  });

  it('never renders a link to a script-bearing scheme', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
      const out = html(`see ${href} and [click](${href})`);
      expect(out).not.toContain('<a ');
      expect(out).not.toContain('href=');
    }
  });

  it('passes only web schemes through the link-target guard', () => {
    expect(safeHref('https://nekkoagent.com')).toBe('https://nekkoagent.com');
    expect(safeHref('http://nekkoagent.com')).toBe('http://nekkoagent.com');
    expect(safeHref('mailto:hi@nekkoagent.com')).toBe('mailto:hi@nekkoagent.com');
    expect(safeHref('JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(safeHref('/relative/path')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });

  it('leaves snake_case and arithmetic alone', () => {
    const out = html('call some_long_name(x) when 2 * 3 * 4 is odd');
    expect(out).not.toContain('<em>');
    expect(out).toContain('some_long_name(x)');
  });

  it('renders nothing for empty text', () => {
    expect(html('')).not.toContain('<p');
    expect(html('   \n  ')).not.toContain('<p');
  });
});

const doc = (text: string) => renderToStaticMarkup(<Markdown text={text} doc />);

describe('Markdown (document mode)', () => {
  it('gives headings a real tag and a size scale', () => {
    expect(doc('# Title')).toContain('<h1');
    expect(doc('## Section')).toContain('<h2');
    expect(doc('###### Deep')).toContain('<h6');
    // Chat mode keeps its flat, quiet headings.
    expect(html('# Title')).not.toContain('<h1');
  });

  it('reflows a hard-wrapped paragraph instead of breaking every line', () => {
    const out = doc('one line\nwrapped here');
    expect(out).toContain('one line wrapped here');
    expect(out).not.toContain('<br/>');
  });

  it('strips embedded HTML down to its text, and drops layout-only lines', () => {
    const out = doc('<div align="center">\n\n# Nekko\n\n</div>');
    expect(out).not.toContain('&lt;div');
    expect(out).toContain('<h1');
    expect(out).toContain('Nekko');
  });

  it('turns an HTML img into the same chip as markdown image syntax', () => {
    const out = doc('<img src="docs/shot.png" alt="A screenshot" />');
    expect(out).toContain('A screenshot');
    expect(out).not.toContain('<img');
  });

  it('hides HTML comments', () => {
    expect(doc('before\n\n<!-- hidden note -->\n\nafter')).not.toContain('hidden note');
  });

  it('renders task lists as checkboxes', () => {
    const out = doc('- [x] shipped\n- [ ] todo');
    expect(out).toContain('☑');
    expect(out).toContain('☐');
    expect(out).not.toContain('[x]');
  });

  it('leaves a relative link as plain text without a document folder', () => {
    const out = doc('see [the guide](CONTRIBUTING.md)');
    expect(out).toContain('the guide');
    expect(out).not.toContain('<a');
  });

  it('does not mistake indexed code for a link', () => {
    expect(html('read rows[0](x) carefully')).toContain('rows[0](x)');
  });
});

// The chat renderer splits text into blocks so a streaming reply re-parses only
// its tail. It has to produce exactly what parsing the whole string produces.
const whole = (text: string) =>
  renderToStaticMarkup(<div className="space-y-1 text-sm leading-[1.6]">{renderWhole(text, { doc: false })}</div>);

const FIXTURES = [
  'Nekko Agent project.\n- first thing\n- second thing',
  '- top\n  - child\n  - sibling\n- next top',
  'one\ntwo',
  '- bullet\n1. number',
  '1. first\n2. second',
  '## Heading',
  '> quoted',
  '---',
  '| Item | Count |\n| --- | --- |\n| Alpha | 1 |',
  '```ts\n- not a bullet\n```',
  '**b** *i* ~~s~~ `c` [text](https://nekkoagent.com)',
  'see https://nekkoagent.com now',
  'call some_long_name(x) when 2 * 3 * 4 is odd',
  '',
  '   \n  ',
  'read rows[0](x) carefully',
];

const REPLY = [
  '## Plan',
  '',
  'First I read the **parser** and the `tokenizer`, then:',
  '- split the lexer',
  '  - keep the fast path',
  '- add tests',
  '',
  '   ',
  '> A quote that runs',
  '> over two lines',
  '',
  '| File | Change |',
  '| --- | --- |',
  '| lexer.ts | split |',
  '',
  '```ts',
  'const x = 1;',
  '',
  '- still code',
  '```',
  'Text glued to the fence, then a rule:',
  '---',
  '1. one',
  '2. two',
  '',
  '```',
  'an unlabelled fence',
  '```',
  '',
  'Done: see https://example.com/pr/1.',
].join('\n');

describe('Markdown block split', () => {
  it('renders every fixture exactly as the whole-text parse does', () => {
    for (const text of [...FIXTURES, REPLY]) expect(html(text)).toBe(whole(text));
  });

  it('matches the whole-text parse at every point of a streaming reply', () => {
    // Every prefix, which covers an unterminated fence, a half-typed table row,
    // a list mid-item and a line that is about to become blank.
    for (let n = 0; n <= REPLY.length; n++) {
      const prefix = REPLY.slice(0, n);
      expect(html(prefix), `prefix of ${n} chars`).toBe(whole(prefix));
    }
  });

  it('renders an unterminated fence as code while it streams', () => {
    const out = html('Here:\n\n```ts\nconst a = 1;\n- not yet a bullet');
    expect(out).toContain('<pre');
    expect(out).toContain('- not yet a bullet');
    expect(out).not.toContain('<li');
  });

  it('leaves finished blocks untouched as a reply grows', () => {
    // A segment is final once another begins after it: its key and source must
    // come out the same in every longer prefix, which is what lets React skip it.
    for (let n = 1; n < REPLY.length; n += 3) {
      const before = markdownSegments(REPLY.slice(0, n));
      const after = markdownSegments(REPLY.slice(0, n + 3));
      for (const seg of before.slice(0, -1)) expect(after).toContainEqual(seg);
    }
  });
});

describe('code spans naming an output file', () => {
  it('opens a page, image or PDF named in code, and leaves other code alone', () => {
    const out = renderToStaticMarkup(<Markdown text={'Design: `reports/strip.html`. Built in `src/App.tsx`.'} basePath="/repo" />);
    expect(out).toMatch(/<button[^>]*title="Open \/repo\/reports\/strip\.html"[^>]*><code[^>]*>reports\/strip\.html<\/code><\/button>/);
    expect(out).not.toContain('Open /repo/src/App.tsx');
    expect(out).toMatch(/<code[^>]*>src\/App\.tsx<\/code>/);
  });
  it('stays plain code when a relative path has no folder to resolve against', () => {
    const out = html('Design: `reports/strip.html`.');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('text-ink-soft');
  });
});
