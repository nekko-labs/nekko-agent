import { describe, expect, it } from 'vitest';
import { applyTextEdit, decodeEntities, readPreviewTextEdit } from './htmlTextEdit.js';

const PAGE = `<!doctype html>
<html><head><title>Pricing</title><style>h1 { color: red }</style></head>
<body>
  <h1 class="hero">Simple pricing</h1>
  <p>Pay &amp; go</p>
  <ul><li>Free</li><li>Pro</li><li>Free</li></ul>
  <p>Mixed <b>bold</b> text</p>
  <abbr>Free</abbr>
</body></html>`;

describe('putting a page text edit back into its source', () => {
  it('changes only that text, keeping attributes and the rest of the file byte for byte', () => {
    const out = applyTextEdit(PAGE, { tag: 'h1', old: 'Simple pricing', occurrence: 0, text: 'Fair pricing' });
    expect(out).toBe(PAGE.replace('>Simple pricing<', '>Fair pricing<'));
  });

  it('matches text through its entities and escapes what is typed', () => {
    const out = applyTextEdit(PAGE, { tag: 'p', old: 'Pay & go', occurrence: 0, text: 'Pay <now> & go' });
    expect(out).toContain('<p>Pay &lt;now&gt; &amp; go</p>');
  });

  it('picks the right one of several elements with the same text, and not a longer tag name', () => {
    const out = applyTextEdit(PAGE, { tag: 'li', old: 'Free', occurrence: 1, text: 'Starter' })!;
    expect(out).toContain('<li>Free</li><li>Pro</li><li>Starter</li>');
    expect(out).toContain('<abbr>Free</abbr>');
    expect(applyTextEdit(PAGE, { tag: 'li', old: 'Free', occurrence: 2, text: 'x' })).toBeNull();
  });

  it('refuses an element with tags inside, a missing one, an unchanged text and a bad tag', () => {
    expect(applyTextEdit(PAGE, { tag: 'p', old: 'Mixed bold text', occurrence: 0, text: 'x' })).toBeNull();
    expect(applyTextEdit(PAGE, { tag: 'h2', old: 'Simple pricing', occurrence: 0, text: 'x' })).toBeNull();
    expect(applyTextEdit(PAGE, { tag: 'h1', old: 'Simple pricing', occurrence: 0, text: 'Simple pricing' })).toBeNull();
    expect(applyTextEdit(PAGE, { tag: 'h1>.*', old: 'Simple pricing', occurrence: 0, text: 'x' })).toBeNull();
  });

  it('decodes the usual entities and gives up on ones it does not know', () => {
    expect(decodeEntities('a &lt;b&gt; &#39;c&#x27; &nbsp;d')).toBe("a <b> 'c'  d");
    expect(decodeEntities('&hellip;')).toBeNull();
  });

  it('reads only a well-formed, bounded edit from the page', () => {
    const ok = { nekkoPreview: 'edit', tag: 'H1', old: 'a', occurrence: 0, text: 'b' };
    expect(readPreviewTextEdit(ok)).toEqual({ nekkoPreview: 'edit', tag: 'h1', old: 'a', occurrence: 0, text: 'b' });
    for (const bad of [null, 'edit', { ...ok, nekkoPreview: 'state' }, { ...ok, tag: '<script>' }, { ...ok, occurrence: -1 }, { ...ok, occurrence: 1.5 }, { ...ok, text: 7 }, { ...ok, text: 'x'.repeat(20_001) }]) {
      expect(readPreviewTextEdit(bad)).toBeNull();
    }
  });
});
