import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@nekko-agent/shared';

// The card reads the open chat's published context total from the store.
const state: Record<string, unknown> = {
  providers: [],
  models: [{ id: 'm', contextLength: 1_000_000 }],
  prsBySession: {},
  sessionCtxEstimate: {} as Record<string, number>,
};
vi.mock('../store.js', () => ({ useStore: (pick: (s: typeof state) => unknown) => pick(state) }));
vi.mock('../useGitStatus.js', () => ({ useGitStatus: () => null }));
vi.mock('../compactionStatus.js', () => ({ useCompactionStore: () => false }));
import { WorkspaceCard } from './WorkspaceCard.js';

const session = {
  id: 's1', title: 'Chat', modelId: 'm', providerId: 'p', transcriptTokens: 76_000,
  messageCount: 2, exchangeCount: 1, stalled: false, recentTurns: [], prUrls: [], imageCount: 0, createdAt: 0,
} as unknown as SessionSummary;

const card = (status?: 'working') => renderToStaticMarkup(
  <WorkspaceCard workspace={null} session={session} terminal={null} status={status} isActive={false} now={0} projects={[]} onOpen={() => {}} onClose={() => {}} />,
);

describe('workspace card context readout', () => {
  it('shows the same total the open chat\'s composer gauge shows, idle or working', () => {
    (state.sessionCtxEstimate as Record<string, number>).s1 = 81_000;
    expect(card()).toContain('81k/1M');
    expect(card('working')).toContain('81k/1M');
  });

  it('falls back to the transcript estimate when the chat is not open', () => {
    delete (state.sessionCtxEstimate as Record<string, number>).s1;
    expect(card()).toContain('76k/1M');
  });

  it('publishes every included bundle item, not just the conversation', () => {
    const chat = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    expect(chat).toContain('bundle.items.filter((i) => i.included).reduce((s, i) => s + i.tokens, 0)');
    expect(chat).not.toContain("i.included && i.source === 'conversation')?.tokens");
  });

  it('lets only the pane that draws the gauge publish, not the wall composer copy of the same chat', () => {
    const chat = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    expect(chat).toContain("const publishesContext = surface !== 'composer' && !readOnly;");
    // Both the publish effect and the clear-on-unmount effect are gated.
    expect(chat.match(/if \(!publishesContext\) return;/g)?.length).toBe(2);
  });
});
