import { vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSummary } from '@nekko-agent/shared';
import type { CommandWallState } from '../commandWall.js';

/**
 * Loads the real CommandWall with its window bodies stubbed: chats render as
 * `<div data-chat=id data-surface=... data-clean-start=...>`, and PaneFrame
 * draws its title strip pieces (`[data-frame-icon]`, `[data-frame-status]`,
 * the focus action) around the body. The calling file must import
 * `./browserGlobals.js` first; the store is the real one.
 */
export async function loadWall() {
  vi.doMock('../components/ChatPane.js', () => ({
    ChatPane: ({ sessionId, surface, cleanStart, status }: { sessionId: string; surface: string; cleanStart?: boolean; status?: string }) =>
      <div data-chat={sessionId} data-surface={surface} data-clean-start={String(!!cleanStart)} data-status={status} />,
  }));
  vi.doMock('../components/TerminalPane.js', () => ({ TerminalPane: ({ terminalId }: { terminalId: string }) => <div data-terminal={terminalId} /> }));
  vi.doMock('../components/PaneFrame.js', async (original) => ({
    ...(await original<object>()),
    PaneFrame: ({ title, icon, statusIndicator, focusAction, children }: Record<string, React.ReactNode>) => (
      <section data-title={title as string}><span data-frame-icon>{icon}</span>{statusIndicator && <span data-frame-status>{statusIndicator}</span>}{focusAction}{children}</section>
    ),
  }));
  const wall = await import('../components/CommandWall.js');
  const { DEFAULT_WALL_STATE } = await import('../commandWall.js');
  return {
    ...wall,
    render(state: Partial<CommandWallState>, opts: { sessions?: SessionSummary[]; running?: string[]; pending?: Record<string, unknown>; selectedId?: string | null } = {}) {
      const s = { ...DEFAULT_WALL_STATE, folded: {}, ...state } as CommandWallState;
      return renderToStaticMarkup(
        <wall.CommandWall state={s} setState={vi.fn()} sessions={opts.sessions ?? []} terminals={[]} running={new Set(opts.running ?? [])} pending={(opts.pending ?? {}) as never}
          childrenOf={new Map()} projects={[]} flash={null} selectedId={opts.selectedId ?? null} onSelect={vi.fn()} onAspect={vi.fn()} onOpenChat={vi.fn()}
          onOpenTerminal={vi.fn()} onNewChat={vi.fn()} onNewTerminal={vi.fn()} onAddWindow={vi.fn()} />,
      );
    },
  };
}

/** A chat as the session list carries it. */
export function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: `Chat ${id}`, createdAt: 0, updatedAt: 0, messageCount: 0, exchangeCount: 0, transcriptTokens: 0, recentTurns: [], prUrls: [], imageCount: 0, stalled: false, ...patch } as SessionSummary;
}

/** The opening tag of the wall window for pane `id`. */
export function windowTag(html: string, id: string): string {
  return html.match(new RegExp(`<div class="command-wall-window[^>]*data-wall-pane="${id}"[^>]*>`))?.[0] ?? '';
}

/** Everything inside the wall window for pane `id` (up to the next window). */
export function windowBody(html: string, id: string): string {
  const start = html.indexOf(windowTag(html, id));
  if (start < 0) return '';
  const next = html.indexOf('<div class="command-wall-window', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}
