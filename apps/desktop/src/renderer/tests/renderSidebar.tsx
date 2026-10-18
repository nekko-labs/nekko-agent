import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSettings, SessionSummary } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { AgentSidebar } from '../views/WorkspacesView.js';

/**
 * Server-renders the real Agents panel (the sidebar half of WorkspacesView).
 * The calling file must import `./browserGlobals.js`, mock the store with
 * `liveStore`, and mock `react-dom`'s createPortal to render inline.
 */
export const PROJECT = { id: 'w', name: 'proj', path: '/p', addedAt: 0 };

export function agentSummary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: `Chat ${id}`, workspaceId: PROJECT.id, createdAt: 0, updatedAt: 0, messageCount: 1, exchangeCount: 1, transcriptTokens: 0, recentTurns: [], prUrls: [], imageCount: 0, stalled: false, ...patch } as SessionSummary;
}

export function renderSidebar(opts: { orientation?: 'vertical' | 'horizontal'; sessions?: SessionSummary[]; settings?: Partial<AppSettings> } = {}): string {
  useStore.setState({ settings: { workspaces: [PROJECT], ...opts.settings } as AppSettings, sessions: opts.sessions ?? [agentSummary('s1')] });
  const noop = () => {};
  return renderToStaticMarkup(<AgentSidebar onOpenChat={noop} onOpenTerminal={noop} onCreate={async () => {}} selectedId={null} orientation={opts.orientation ?? 'vertical'} onOrientation={noop} onClosePanel={noop} />);
}
