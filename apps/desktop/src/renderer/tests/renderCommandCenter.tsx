import { vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSettings } from '@nekko-agent/shared';

/**
 * Loads the real Agents page (CommandCenterView) with its heavy children
 * stubbed to markers that echo the props this page gives them, so a test sees
 * the page's own layout and wiring. The calling file must import
 * `./browserGlobals.js` and mock the store with `liveStore`.
 *
 * Stubs: `[data-stub="wall"]` (CommandWall; `data-add-content` says whether an
 * add tile was passed), `[data-stub="composer"]`, `[data-stub="dock"]`,
 * `[data-stub="sidebar"]`.
 */
export const stubProps: { wall?: Record<string, unknown>; sidebar?: Record<string, unknown> } = {};

export async function loadCommandCenter() {
  vi.doMock('../chrome.js', () => ({ hasAppChrome: false, isMacChrome: false }));
  vi.doMock('../components/CommandWall.js', () => ({
    CommandWall: (p: Record<string, unknown>) => { stubProps.wall = p; return <div data-stub="wall" data-add-content={String(p.addContent !== undefined)} />; },
    TerminalExcerpt: () => null,
  }));
  vi.doMock('../components/WallComposer.js', () => ({ WallComposer: () => <div data-stub="composer" /> }));
  vi.doMock('../components/MonitorsDock.js', () => ({ MonitorsDock: () => <div data-stub="dock" /> }));
  vi.doMock('../views/WorkspacesView.js', () => ({ AgentSidebar: (p: Record<string, unknown>) => { stubProps.sidebar = p; return <aside data-stub="sidebar" />; } }));
  vi.doMock('../components/ChatPane.js', () => ({ ChatPane: () => null }));
  const view = await import('../views/CommandCenterView.js');
  const { useStore } = await import('../store.js');
  return {
    ...view,
    useStore,
    render(settings: Partial<AppSettings> = {}) {
      useStore.setState({ settings: settings as AppSettings });
      return renderToStaticMarkup(<view.CommandCenterView />);
    },
  };
}
