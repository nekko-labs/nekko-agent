import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@nekko-agent/shared';

const state: Record<string, unknown> = {
  providers: [], models: [], prsBySession: {}, sessionCtxEstimate: {}, computers: [] as unknown[], computerCatalogs: {},
};
vi.mock('../store.js', () => ({ useStore: (pick: (s: typeof state) => unknown) => pick(state) }));
const gitStatus: { current: unknown } = { current: null };
vi.mock('../useGitStatus.js', () => ({ useGitStatus: () => gitStatus.current }));
vi.mock('../compactionStatus.js', () => ({ useCompactionStore: () => false }));
import { WorkspaceCard } from './WorkspaceCard.js';

const base = { id: 's1', title: 'Chat', modelId: 'm', providerId: 'p', transcriptTokens: 0, messageCount: 2, exchangeCount: 1, stalled: false, recentTurns: [], prUrls: [], imageCount: 0, createdAt: 0 };
const pr = { url: 'https://github.com/o/r/pull/7', owner: 'o', repo: 'r', number: 7, title: 'PR', state: 'open', isDraft: false };
const render = (patch: Partial<SessionSummary> = {}, props: Partial<React.ComponentProps<typeof WorkspaceCard>> = {}) => renderToStaticMarkup(
  <WorkspaceCard workspace={null} session={{ ...base, ...patch } as unknown as SessionSummary} terminal={null} status="done" isActive={false} now={0} projects={[]} onOpen={() => {}} onClose={() => {}} {...props} />,
);
/** The card's rows as markup, top to bottom: the title row, then each metadata line. */
const lines = (html: string) => html.split('<div ').slice(2);
const at = (html: string, marker: string) => lines(html).findIndex((l) => l.includes(marker));

describe('tags on a sidebar card', () => {
  it('shows up to three tags at the right end of the branch line, opposite the branch, and +N for the rest', () => {
    state.prsBySession = {};
    gitStatus.current = { workspaceId: 'session:s1', repo: true, branch: 'feat/x', dirtyCount: 0, ahead: 0, behind: 3 };
    try {
      const html = render({ tags: ['a', 'b', 'c', 'd', 'e'] });
      const branchLine = lines(html)[at(html, 'data-chat-tags')];
      expect(branchLine).toContain('feat/x');
      expect(branchLine.indexOf('feat/x')).toBeLessThan(branchLine.indexOf('data-chat-tags'));
      expect(branchLine.indexOf('↓3')).toBeLessThan(branchLine.indexOf('data-chat-tags'));
      // Pushed to the far end of the line.
      expect(branchLine).toMatch(/<span class="chat-tags ms-auto shrink justify-end ps-2" data-chat-tags="true" data-chat-tags-inline="true">/);
      expect(lines(html).some((l) => l.includes('>m<') && l.includes('data-chat-tags'))).toBe(false);
      expect(html.match(/class="chat-tag-chip"/g)).toHaveLength(3);
      expect(html).toContain('>+2<');
      expect(html).not.toContain('>#d<');
    } finally { gitStatus.current = null; }
  });

  it('names the hidden tags when +N is hovered', () => {
    for (const git of [null, { workspaceId: 'session:s1', repo: true, branch: 'feat/x', dirtyCount: 0, ahead: 0, behind: 0 }]) {
      gitStatus.current = git;
      const html = render({ tags: ['a', 'b', 'c', 'd', 'e'] });
      expect(html).toMatch(/<span class="chat-tag-more" title="#d #e" aria-label="2 more: #d #e" data-chat-tags-more="true">\+2<\/span>/);
    }
    gitStatus.current = null;
    expect(render({ tags: ['a', 'b', 'c'] })).not.toContain('data-chat-tags-more');
  });

  it('shows nothing without tags, with metadata off, or with only blank ones', () => {
    state.prsBySession = {};
    expect(render({})).not.toContain('data-chat-tags');
    expect(render({ tags: [' ', '#'] })).not.toContain('data-chat-tags');
    expect(render({ tags: ['a'] }, { showMetadata: false })).not.toContain('data-chat-tags');
  });

  it('takes no line of its own while the branch line shows, and sits before the PR chip there', () => {
    gitStatus.current = { workspaceId: 'session:s1', repo: true, branch: 'feat/x', dirtyCount: 0, ahead: 0, behind: 3 };
    try {
      state.prsBySession = { s1: [pr] };
      const withPr = render({ tags: ['a'] });
      expect(withPr).not.toMatch(/<div class="chat-tags/);
      const line = lines(withPr)[at(withPr, 'data-chat-tags')];
      expect(line).toContain('data-session-pr-chip');
      expect(line.indexOf('data-chat-tags')).toBeLessThan(line.indexOf('data-session-pr-chip'));
      state.prsBySession = {};
      expect(render({ tags: ['a'] })).not.toMatch(/<div class="chat-tags/);
    } finally { gitStatus.current = null; }
  });

  it('falls back to a line of its own above the last line when there is no branch line', () => {
    state.prsBySession = {};
    gitStatus.current = null;
    const html = render({ tags: ['a'] });
    expect(html).toMatch(/<div class="chat-tags pl-3 text-2xs leading-3" data-chat-tags="true">/);
    expect(lines(html)[at(html, 'data-chat-tags') + 1]).toContain('>m<');
  });

  it('uses the quiet chip styling, no colour of its own', () => {
    const css = require('node:fs').readFileSync(new URL('./chatTags.css', import.meta.url), 'utf8') as string;
    expect(css).toContain('var(--ink-faint)');
    // Quiet metadata: text only, no border, ring, outline, fill or rounding at rest.
    expect(css.replace(/\/\*[^]*?\*\//g, '')).not.toMatch(/border|outline|box-shadow|background/);
    expect(css).toContain('padding: 0;');
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(render({ tags: ['a'] })).not.toMatch(/style="[^"]*#[0-9a-f]{3,6}/i);
  });

  it('draws the tags as plain quiet text on the branch line, with no border or fill', () => {
    gitStatus.current = { workspaceId: 'session:s1', repo: true, branch: 'feat/x', dirtyCount: 0, ahead: 0, behind: 3 };
    try {
      const html = render({ tags: ['a', 'b'] });
      const inline = html.match(/<span class="chat-tags[^"]*"[^>]*data-chat-tags-inline="true">/)![0];
      expect(inline).not.toMatch(/border|rounded|bg-|ring/);
      expect(html.match(/class="chat-tag-chip"/g)).toHaveLength(2);
    } finally { gitStatus.current = null; }
  });

  it('names an unnamed group\'s dot by its colour', () => {
    const html = render({}, { chatGroupColor: 'var(--zone-tint-0)', chatGroupLabel: 'Untitled group (Teal)' });
    expect(html).toMatch(/aria-label="Untitled group \(Teal\)"[^>]*style="background:var\(--zone-tint-0\)"/);
    expect(render({}, { chatGroupColor: 'var(--zone-tint-0)', chatGroupLabel: 'Group: Docs' })).toContain('aria-label="Group: Docs"');
  });
});
