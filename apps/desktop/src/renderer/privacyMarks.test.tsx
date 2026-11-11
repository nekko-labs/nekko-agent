import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PrivacyPreview } from '@nekko-agent/shared';
import { draftPrivacyMarks, markPrivacyNodes, privacyMarkRanges, usePrivacyPreviews, type PrivacyMark } from './privacyMarks.js';
import { composerMarkdownNodes } from './components/agent-console/ComposerHighlight.js';

const email: PrivacyMark = { value: 'jane@acme.com', token: '[PII_EMAIL_1]', kind: 'email' };
const term: PrivacyMark = { value: 'acme', token: '[PII_TERM_1]', kind: 'term' };

const preview = (patch: Partial<PrivacyPreview> = {}): PrivacyPreview => ({
  enabled: true, reach: 'cloud', draft: '', allowed: [], disabledKinds: [], terms: [], kinds: [],
  findings: [
    { kind: 'email', value: 'jane@acme.com', token: '[PII_EMAIL_1]', count: 1, inDraft: true, inChat: false },
    { kind: 'phone', value: '555-0100', token: '[PII_PHONE_1]', count: 1, inDraft: false, inChat: true },
  ],
  ...patch,
} as PrivacyPreview);

/** The editor's markup with marks, as the composer paints it. */
const paint = (text: string, marks: PrivacyMark[]) =>
  renderToStaticMarkup(<>{markPrivacyNodes(composerMarkdownNodes(text), text, marks)}</>);

/** Strip tags: what `textContent` would read. Generated brackets and placeholders are CSS. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'");

describe('Privacy Shield marks in the composer', () => {
  it('marks only draft values, and only when the shield is on for a cloud model', () => {
    expect(draftPrivacyMarks(preview(), true)).toEqual([email]);
    expect(draftPrivacyMarks(preview(), false)).toEqual([]);
    expect(draftPrivacyMarks(preview({ reach: 'local' }), true)).toEqual([]);
    expect(draftPrivacyMarks(null, true)).toEqual([]);
  });

  it('finds every occurrence, the longer value winning an overlap', () => {
    const text = 'Mail jane@acme.com about acme, then jane@acme.com again.';
    const ranges = privacyMarkRanges(text, [term, email]);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(['jane@acme.com', 'acme', 'jane@acme.com']);
  });

  it('wraps each value with its placeholder, and leaves the text unchanged', () => {
    const text = 'Write to jane@acme.com today';
    const html = paint(text, [email]);
    expect(html).toContain('<mark class="composer-privacy-mark" data-privacy-kind="email" data-privacy-open="" data-privacy-token="[PII_EMAIL_1]">jane@acme.com</mark>');
    expect(textOf(html)).toBe(text);
  });

  it('splits a value that crosses styled spans, opening on the first piece and closing on the last', () => {
    // The underscores read as italics, so the address spans three styled runs.
    const value = 'a_b@x_y.com';
    const text = `Mail ${value} now`;
    const html = paint(text, [{ ...email, value }]);
    const pieces = [...html.matchAll(/<mark[^>]*>([^<]*)<\/mark>/g)];
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((m) => m[1]).join('')).toBe(value);
    expect(pieces[0][0]).toContain('data-privacy-open');
    expect(pieces[0][0]).not.toContain('data-privacy-token');
    expect(pieces.at(-1)![0]).toContain('data-privacy-token="[PII_EMAIL_1]"');
    expect(textOf(html)).toBe(text);
  });

  it('paints nothing extra without marks', () => {
    const text = 'nothing private here';
    expect(paint(text, [])).toBe(renderToStaticMarkup(<>{composerMarkdownNodes(text)}</>));
  });

  it('shares one preview per chat', () => {
    const p = preview();
    usePrivacyPreviews.getState().publish('chat-1', p);
    expect(usePrivacyPreviews.getState().bySession['chat-1']).toBe(p);
    usePrivacyPreviews.getState().publish('chat-1', null);
    expect(usePrivacyPreviews.getState().bySession['chat-1']).toBeUndefined();
  });
});
