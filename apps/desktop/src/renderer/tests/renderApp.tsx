import { vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSettings } from '@nekko-agent/shared';

/**
 * Server-renders the real App shell (nav rail, phone tabs, corner mascot) with
 * every page and the host-backed chrome around it stubbed out, so a test sees
 * what the shell itself draws for a given store state.
 *
 * The calling file must import `./browserGlobals.js` and mock the store with
 * `liveStore` before calling this; the stubs are `vi.doMock`ed here, so App is
 * imported fresh per call.
 */
const VIEWS = ['DesignBoardView', 'ArtifactsView', 'SkillsView', 'TrainingView', 'WorkflowsView', 'CommandCenterView', 'ModelsView', 'ModelServerView', 'ConnectorsView', 'MemoryView', 'SettingsView', 'OnboardingView'];
const CHROME: Array<[string, string]> = [
  ['AboutNekko', 'AboutNekko'], ['UpdateBanner', 'UpdateBanner'], ['RelayPairing', 'RelayPairing'], ['CommandPalette', 'CommandPalette'],
  ['DeepLink', 'DeepLinkListener'], ['Toasts', 'Toasts'], ['TitleBar', 'TitleBar'], ['ResourceMonitor', 'ResourceHud'], ['AutumnBackground', 'AutumnBackground'],
];

export async function renderApp(settings: Partial<AppSettings>, view = 'command'): Promise<string> {
  for (const v of VIEWS) vi.doMock(`../views/${v}.js`, () => ({ [v]: () => <div data-view={v} /> }));
  for (const [file, name] of CHROME) vi.doMock(`../components/${file}.js`, () => ({ [name]: () => null }));
  const { useStore } = await import('../store.js');
  const { App } = await import('../App.js');
  useStore.setState({ settingsLoaded: true, settings: settings as AppSettings, view: view as never, providers: [{ id: 'p' }] as never });
  return renderToStaticMarkup(<App />);
}
