import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { composerMarkdownNodes } from './ComposerHighlight.js';

const html = (text: string) => renderToStaticMarkup(<div>{composerMarkdownNodes(text)}</div>);
// The rendered text with the markup removed; split/join drops every tag in one pass.
const textOf = (markup: string) => markup.split(/<[^>]*>/).join('');

const ACCENT = 'var(--accent)';
const FAINT = 'var(--ink-faint)';

describe('composerMarkdownNodes', () => {
  it('leaves plain text untouched', () => {
    const out = html('just a sentence');
    expect(out).toContain('just a sentence');
    expect(out).not.toContain(ACCENT);
  });

  it('sizes and emphasizes headings on the editable surface', () => {
    const out = html('## Plan\nbody');
    expect(out).toContain(`color:${ACCENT}">##</span>`);
    expect(out).toContain(' Plan');
    expect(out).toContain('font-size:1.4em');
    expect(out).toContain('font-weight:600');
    expect(out).not.toContain('font-style');
  });

  it('colors list markers, including task boxes', () => {
    const out = html('- one\n  - [ ] two\n3. three');
    expect(out).toContain(`color:${ACCENT}">-</span>`);
    expect(out).toContain(`color:${ACCENT}"> [ ]</span>`);
    expect(out).toContain(`color:${ACCENT}">3.</span>`);
  });

  it('dims blockquote text and tints its marker', () => {
    const out = html('> quoted words');
    expect(out).toContain(`color:${ACCENT}">&gt;</span>`);
    expect(out).toContain('var(--ink-soft)');
  });

  it('dims fence markers and does not interpret code as Markdown', () => {
    const out = html('```\n- not a list\n```\n- a list');
    const fenceCount = (out.match(/color:var\(--ink-faint\)">```/g) ?? []).length;
    expect(fenceCount).toBe(2);
    // Inside the fence the dash is not a list marker; after it, it is.
    expect(out).toContain('- not a list');
    expect(out).toContain(`color:${ACCENT}">-</span>`);
  });

  it.each(['`', '```'])('syntax highlights %s blocks without interpreting Markdown or HTML', (fence) => {
    const text = `${fence}\nconst value = 42;\n"<img src=x onerror=alert(1)>"\n**not bold**\n${fence}\n- list`;
    const out = html(text);
    expect(out).toContain(`color:${ACCENT}">const</span>`);
    expect(out).toContain('color:var(--accent-2)">42</span>');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('font-weight');
    expect(out).toContain(`color:${ACCENT}">-</span>`);
    expect(textOf(out)).toBe(renderToStaticMarkup(<>{text}</>));
  });

  it('only treats a single backtick alone on a line as a short fence', () => {
    const out = html('run `const` now\n`js\n- list');
    expect(out).toContain('border-radius:3px');
    expect(out).not.toContain(`color:${ACCENT}">const</span>`);
    expect(out).toContain(`color:${ACCENT}">-</span>`);
  });

  it.each(['`\n```\n- code\n`\n- list', '```\n`\n- code\n```\n- list'])('does not close a fence with a different marker', (text) => {
    const out = html(text);
    expect(out).toContain('- code');
    expect((out.match(/class="composer-bullet"/g) ?? []).length).toBe(1);
    expect(textOf(out)).toBe(text);
  });

  it.each(['  `  \r\nconst n = 1;\r\n  `\r\n', '`\nconst n = 1;\n', '```js\n/* start\nconst n = 1;\nend */\n```'])('preserves raw text, whitespace and incomplete blocks', (text) => {
    expect(textOf(html(text))).toBe(text);
  });

  it('keeps multiline comments in a single syntax token', () => {
    const out = html('`\n/* start\nconst n = 1;\nend */\n`');
    expect(out).toContain(`color:${FAINT}">/* start\nconst n = 1;\nend */</span>`);
    expect(out).not.toContain(`color:${ACCENT}">const</span>`);
  });

  it('fades emphasis marks and strikes struck text', () => {
    const out = html('**bold** and ~~gone~~');
    expect(out).toContain(`color:${FAINT}">**</span>`);
    expect(out).toContain('bold');
    expect(out).toContain('line-through');
  });

  it('marks inline code without padding, which would shift glyphs', () => {
    const out = html('run `npm test` now');
    expect(out).toContain('npm test');
    expect(out).not.toContain('padding');
  });
});
