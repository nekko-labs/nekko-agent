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
const gitStatus: { current: unknown } = { current: null };
vi.mock('../useGitStatus.js', () => ({ useGitStatus: () => gitStatus.current }));
vi.mock('../compactionStatus.js', () => ({ useCompactionStore: () => false }));
import { WorkspaceCard, chatRenameTitle } from './WorkspaceCard.js';

const session = {
  id: 's1', title: 'Chat', modelId: 'm', providerId: 'p', transcriptTokens: 76_000,
  messageCount: 2, exchangeCount: 1, stalled: false, recentTurns: [], prUrls: [], imageCount: 0, createdAt: 0,
} as unknown as SessionSummary;

const card = (status?: 'working' | 'done' | 'idle', chat: SessionSummary = session) => renderToStaticMarkup(
  <WorkspaceCard workspace={null} session={chat} terminal={null} status={status} isActive={false} now={0} projects={[]} onOpen={() => {}} onClose={() => {}} />,
);

describe('workspace card completion control', () => {
  it('shows an X for completion, keeping the Complete name and retention title', () => {
    const html = card();
    expect(html).toContain('aria-label="Complete Chat"');
    expect(html).toContain('title="Complete this chat (kept until you delete it)"');
    // The status may be a done check, but the action must remain an X.
    const action = html.match(/<button[^>]*aria-label="Complete Chat"[^]*?<\/button>/)?.[0] ?? '';
    expect(action).toContain('M18 6 6 18M6 6l12 12');
    expect(action).not.toContain('M20 6 9 17l-5-5');
  });

  it('keeps the last-reply time for done and idle cards, not working ones', () => {
    const replied = { ...session, lastReplyAt: -60_000 } as SessionSummary;
    expect(card('done', replied)).toContain('1 min ago');
    expect(card('idle', replied)).toContain('1 min ago');
    expect(card('working', replied)).not.toContain('min ago');
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

  it('keeps chat rows flat while status and title carry attention and selection', () => {
    for (const patch of [{}, { status: 'input' as const }, { status: 'error' as const }, { isActive: true }]) {
      const html = render(patch);
      expect(html).toContain('agent-chip-chat');
      expect(html).not.toContain('bg-accent-soft');
      expect(html).not.toContain('border-color:');
    }
    expect(render({ status: 'input' })).toContain('var(--attention)');
    expect(render({ isActive: true })).toContain('font-medium text-ink');
  });
});

describe('workspace card rename', () => {
  const terminal = { id: 't1', title: 'zsh', shell: '/bin/zsh' } as unknown as Parameters<typeof WorkspaceCard>[0]['terminal'];

  it('offers a pencil beside the X on a chat card, not on a terminal', () => {
    const chat = renderToStaticMarkup(
      <WorkspaceCard workspace={null} session={session} terminal={null} status={undefined} isActive={false} now={0} projects={[]} onOpen={() => {}} onClose={() => {}} onRenameStart={() => {}} onRename={() => {}} />,
    );
    expect(chat).toContain('aria-label="Rename Chat"');
    expect(chat.indexOf('aria-label="Rename Chat"')).toBeLessThan(chat.indexOf('aria-label="Complete Chat"'));
    const shell = renderToStaticMarkup(
      <WorkspaceCard workspace={null} session={null} terminal={terminal} status={undefined} isActive={false} now={0} projects={[]} onOpen={() => {}} onClose={() => {}} onRenameStart={() => {}} onRename={() => {}} />,
    );
    expect(shell).not.toContain('aria-label="Rename');
  });

  it('turns the title into a text field while renaming, with no pencil', () => {
    const html = renderToStaticMarkup(
      <WorkspaceCard workspace={null} session={session} terminal={null} status={undefined} isActive={false} now={0} projects={[]} renaming onOpen={() => {}} onClose={() => {}} onRenameStart={() => {}} onRename={() => {}} />,
    );
    expect(html).toMatch(/<input[^>]*aria-label="Chat title"[^>]*value="Chat"/);
    expect(html).not.toContain('aria-label="Rename Chat"');
  });

  it('saves a trimmed new title and nothing else', () => {
    expect(chatRenameTitle('  Login form fix ', 'Chat')).toBe('Login form fix');
    expect(chatRenameTitle(null, 'Chat')).toBeNull();
    expect(chatRenameTitle('   ', 'Chat')).toBeNull();
    expect(chatRenameTitle('Chat', 'Chat')).toBeNull();
  });
});

describe('workspace card PR chip', () => {
  const pr = (number: number, state: 'open' | 'merged' | 'closed', isDraft = false) =>
    ({ url: `https://github.com/o/r/pull/${number}`, owner: 'o', repo: 'r', number, title: `PR ${number}`, state, isDraft });
  const render = (props: Partial<React.ComponentProps<typeof WorkspaceCard>> = {}) => renderToStaticMarkup(
    <WorkspaceCard workspace={null} session={session} terminal={null} status="done" isActive={false} now={0} projects={[]} onOpen={() => {}} onClose={() => {}} {...props} />,
  );
  /** The card's rows as markup, top to bottom: the title row, then each metadata line (rows hold no divs). */
  const lines = (html: string) => html.split('<div ').slice(2);
  const chipLine = (html: string) => lines(html).findIndex((l) => l.includes('data-session-pr-chip'));
  const withPrs = (prs: unknown[]) => { (state.prsBySession as Record<string, unknown>).s1 = prs; };

  it('shows no chip for a chat without PRs', () => {
    withPrs([]);
    expect(render()).not.toContain('data-session-pr-chip');
  });

  it('ends the last line with one chip for the most relevant PR', () => {
    withPrs([pr(7, 'merged'), pr(8, 'open', true)]);
    const html = render();
    expect(html.match(/data-session-pr-chip/g)).toHaveLength(1);
    expect(html).toContain('data-pr-status="draft"');
    expect(html).toContain('>+1<');
    // No branch, provider or sub-agents: the model line is last, and the chip ends it.
    const rows = lines(html);
    expect(chipLine(html)).toBe(rows.length - 1);
    expect(rows[rows.length - 1]).toMatch(/<span class="ml-auto[^"]*"><span[^>]*data-session-pr-chip[^]*<\/span><\/span><\/div><\/div>$/);
  });

  it('moves down to the branch line, then the spawn line, when they are there', () => {
    withPrs([pr(7, 'open')]);
    gitStatus.current = { workspaceId: 'session:s1', repo: true, branch: 'feat/x', dirtyCount: 0, ahead: 0, behind: 0 };
    try {
      let html = render();
      expect(chipLine(html)).toBe(lines(html).length - 1);
      expect(lines(html)[chipLine(html)]).toContain('feat/x');
      html = render({ subAgentCount: 2 });
      expect(chipLine(html)).toBe(lines(html).length - 1);
      expect(lines(html)[chipLine(html)]).toContain('sub-agent');
      expect(lines(html)[chipLine(html)]).not.toContain('feat/x');
    } finally {
      gitStatus.current = null;
    }
  });

  it('rides the title row of a title-only card, in place of the reply time', () => {
    withPrs([pr(7, 'closed')]);
    const replied = { ...session, lastReplyAt: -60_000 } as SessionSummary;
    const html = render({ showMetadata: false, session: replied });
    expect(html).toContain('data-pr-status="closed"');
    expect(chipLine(html)).toBe(0);
    expect(html).not.toContain('min ago');
    withPrs([]);
    expect(render({ showMetadata: false, session: replied })).toContain('1 min ago');
  });
});
