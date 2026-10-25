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

const card = (status?: 'working', chat: SessionSummary = session) => renderToStaticMarkup(
  <WorkspaceCard workspace={null} session={chat} terminal={null} status={status} isActive={false} now={0} projects={[]} onOpen={() => {}} onClose={() => {}} />,
);

describe('workspace card completion control', () => {
  it('shows an X for completion, keeping the Complete name and retention title', () => {
    const html = card();
    expect(html).toContain('aria-label="Complete Chat"');
    expect(html).toContain('title="Complete this chat (kept for 60 days)"');
    // The status may be a done check, but the action must remain an X.
    const action = html.match(/<button[^>]*aria-label="Complete Chat"[^]*?<\/button>/)?.[0] ?? '';
    expect(action).toContain('M18 6 6 18M6 6l12 12');
    expect(action).not.toContain('M20 6 9 17l-5-5');
  });
});

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

  it('prefers what Claude Code reported for a Claude Agent chat over the transcript estimate and model guess', () => {
    const claudeAgent = {
      ...session, modelId: 'opus', transcriptTokens: 3_000,
      claudeCodeContext: { used: 42_000, window: 200_000, model: 'claude-opus-5-5', modelId: 'opus' },
    } as unknown as SessionSummary;
    expect(card(undefined, claudeAgent)).toContain('42k/200k');
    // Switched to another model since: back to the estimate against the alias guess.
    expect(card(undefined, { ...claudeAgent, modelId: 'sonnet' })).toContain('3.0k/1M');
  });

  // Source pins, pending the wall e2e journey: the card's number is published
  // from ChatPane effects (on mount, on a context bundle from the host, and on
  // unmount), none of which a server render runs.
  it('publishes every included bundle item, not just the conversation (source pin)', () => {
    const chat = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    const publish = chat.match(/const publish = \(\) => \{[^]*?setSessionCtxEstimate\(sessionId, base \+ live\);/)?.[0] ?? '';
    expect(publish).toMatch(/bundle\.items\.filter\(\(i\) => i\.included\)\.reduce\(\(s, i\) => s \+ i\.tokens, 0\)/);
    expect(publish).not.toMatch(/source === 'conversation'/);
  });

  it('lets only the pane that draws the gauge publish, not the wall composer copy of the same chat (source pin)', () => {
    const chat = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    expect(chat).toMatch(/const publishesContext = surface !== 'composer' && !readOnly;/);
    // Both the publish effect and the clear-on-unmount effect are gated.
    expect(chat.match(/if \(!publishesContext\) return;/g)?.length).toBe(2);
  });
});

describe('workspace card model line and attention', () => {
  const render = (props: Partial<React.ComponentProps<typeof WorkspaceCard>> = {}) => renderToStaticMarkup(
    <WorkspaceCard workspace={null} session={{ ...session, modelId: 'claude-opus-5-5' } as SessionSummary} terminal={null} status={undefined}
      isActive={false} now={0} projects={[]} onOpen={() => {}} onClose={() => {}} {...props} />,
  );

  it('names the model alone, with its provider as optional subtext under it', () => {
    state.providers = [{ id: 'p', label: 'Claude', kind: 'anthropic' }];
    const html = render();
    expect(html).toContain('Opus 5.5');
    expect(html).toContain('<span class="min-w-0 truncate">Opus 5.5</span>');
    expect(html).toMatch(/data-card-provider[^>]*>Claude</);
    expect(render({ showProvider: false })).not.toContain('data-card-provider');
    state.providers = [];
  });

  it('highlights a card waiting on you like the active one', () => {
    expect(render()).not.toContain('bg-accent-soft');
    expect(render({ status: 'input' })).toContain('bg-accent-soft');
    expect(render({ status: 'error' })).toContain('bg-accent-soft');
    expect(render({ status: 'input' })).toContain('var(--attention)');
  });
});
