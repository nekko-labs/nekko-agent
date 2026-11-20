import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSettings, SessionSummary } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { AgentSidebar } from '../views/WorkspacesView.js';
import { AGENT_PANEL_SHOWS_KEY, type AgentPanelShows } from '../views/agentPanelView.js';

/**
 * Server-renders the real Agents panel (`AgentSidebar` in WorkspacesView.tsx).
 * The calling file must import `./browserGlobals.js`, mock the store with
 * `liveStore`, and mock `react-dom`'s createPortal to render inline.
 */
export const PROJECT = { id: 'w', name: 'proj', path: '/p', addedAt: 0 };

export function agentSummary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: `Chat ${id}`, workspaceId: PROJECT.id, createdAt: 0, updatedAt: 0, messageCount: 1, exchangeCount: 1, transcriptTokens: 0, recentTurns: [], prUrls: [], imageCount: 0, stalled: false, ...patch } as SessionSummary;
}

/** `shows` picks the switcher's window kind (Agents unless given), as a saved choice would. */
export function renderSidebar(opts: { shows?: AgentPanelShows; sessions?: SessionSummary[]; settings?: Partial<AppSettings>; openFiles?: string[]; activeFile?: string } = {}): string {
  useStore.setState({ settings: { workspaces: [PROJECT], ...opts.settings } as AppSettings, sessions: opts.sessions ?? [agentSummary('s1')] });
  localStorage.setItem(AGENT_PANEL_SHOWS_KEY, opts.shows ?? 'agents');
  const noop = () => {};
  return renderToStaticMarkup(<AgentSidebar onOpenChat={noop} onOpenTerminal={noop} onCreate={async () => {}} selectedId={null} onClosePanel={noop} onOpenFile={noop} openFiles={opts.openFiles} activeFile={opts.activeFile} />);
}
