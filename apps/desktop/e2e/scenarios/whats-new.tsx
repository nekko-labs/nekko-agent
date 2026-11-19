import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../../src/renderer/store';
import { UpdateControl, UpdateProvider } from '../../src/renderer/components/UpdateBanner';
import { UpdatesSection } from '../../src/renderer/views/SettingsView';
import { AboutNekko } from '../../src/renderer/components/AboutNekko';
import { CommandPalette } from '../../src/renderer/components/CommandPalette';
import { WhatsNewSheet } from '../../src/renderer/components/WhatsNewSheet';
import bundled from '../../src/renderer/whatsNew.json';
import { highlightsFor, prUrl, releaseUrl, splitHighlights } from '../../src/renderer/whatsNew';
import '../../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host, daemon or the network:
// links the sheet would open are recorded in `integration.opened` instead.
const opened: string[] = [];
let version = '0.10.1004';
// What the sheet reads: the bundled file, or a long synthetic line (`integration.long`).
let data: unknown = bundled;

const settings = { providers: [], workspaces: [], experimental: {}, agent: {}, ui: {}, updates: {} } as any;

Object.assign(window, {
  nekko: new Proxy({
    getAppInfo: async () => ({ version, platform: 'win32', edition: 'desktop' }),
    openPath: async (url: string) => { opened.push(url); },
    listSessionSummaries: async () => [],
  } as any, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }),
});

function Fixture() {
  // A new key remounts the updater, as a relaunch on another version would.
  const [run, setRun] = useState(0);

  React.useLayoutEffect(() => { useStore.setState({ sessions: [], providers: [], terminals: [], workspaces: [], settings } as any); }, []);

  Object.assign(window, {
    integration: {
      opened,
      /** What the build bundles, so the journey follows the data instead of repeating it. */
      lines: Object.fromEntries(Object.entries(bundled as Record<string, unknown[]>).map(([line, list]) => [line, list.length])),
      expected: (v: string) => ({ ...splitHighlights(highlightsFor(v, data)), release: releaseUrl(v) }),
      /** A release with many changes: line 0.97 gets `count` synthetic highlights. Shows on the next launch. */
      long: (count: number) => {
        data = { '0.97': Array.from({ length: count }, (_, i) => ({ title: `Synthetic change ${i + 1}`, detail: `What change ${i + 1} does for you.`, pr: 9000 + i, icon: 'sparkles' })) };
      },
      prUrl,
      /** Relaunch on `next`; `updatedFrom` is the version the last launch ran, which shows the pill. */
      launch: (next: string, updatedFrom?: string) => {
        version = next;
        localStorage.setItem('op_last_version', updatedFrom ?? next);
        setRun((n) => n + 1);
      },
      /** Relaunch on the same version: nothing but the remount, so storage is as the app left it. */
      relaunch: () => setRun((n) => n + 1),
      about: () => window.dispatchEvent(new Event('nekko:about')),
      palette: () => useStore.getState().setPaletteOpen(true),
    },
  });

  return (
    <UpdateProvider key={run}>
      <header className="flex h-10 items-center justify-end px-4 text-xs" data-fixture-titlebar><UpdateControl /></header>
      <main className="mx-auto max-w-[720px] p-5">
        <UpdatesSection settings={settings} update={() => {}} />
      </main>
      <AboutNekko />
      <CommandPalette />
      <WhatsNewSheet data={data} />
    </UpdateProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
