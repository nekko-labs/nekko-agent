import React from 'react';
import { startTelemetry } from './telemetry.js';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ensureNekko } from './web-client.js';
import { CloudLogin, cloudAuthRequired } from './components/CloudLogin.js';
import { UpdateProvider } from './components/UpdateBanner.js';
// The website's two fonts, bundled so the app never fetches them (--font-sans, --font-mono).
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { useStore } from './store.js';
import { fadeInReloadCover, pageWasReloaded, playReloadCover, playSplash } from './splash.js';
import { transcriptsLoaded } from './sessionCache.js';
import { windowChrome } from './chrome.js';
import { isScreenWindow } from './displays.js';
import { presenterRequest, startPresenterMode } from './presenter.js';

// Presenter mode masks personal details outside Settings for recordings.
const presenter = presenterRequest();
if (presenter) startPresenterMode(presenter);

// Resolve the system preference before mounting even the loading or login UI.
useStore.getState().applyTheme();

// The startup splash plays over the app and lifts once settings, providers and
// the open chats have loaded, so it opens onto the real app rather than a
// half-loaded one. A reload gets the quiet cover instead of the launch splash.
// A very long chat doesn't get to hold it up: past this it fills in on screen.
const TRANSCRIPT_WAIT_MS = 1000;
if (!isScreenWindow) {
  const appLoaded = (s: ReturnType<typeof useStore.getState>) => s.settingsLoaded && s.providersLoaded;
  const loaded = new Promise<void>((resolve) => {
    if (appLoaded(useStore.getState())) return resolve();
    const stop = useStore.subscribe((s) => { if (appLoaded(s)) { stop(); requestAnimationFrame(() => resolve()); } });
  }).then(() => Promise.race([transcriptsLoaded(), new Promise((r) => setTimeout(r, TRANSCRIPT_WAIT_MS))]));
  if (pageWasReloaded()) playReloadCover(loaded);
  else playSplash(loaded);
  windowChrome?.onPageReloading(fadeInReloadCover);
}

function registerServiceWorker() {
  // Web/PWA editions only (not Electron's file://).
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
}

function startApp(root: ReturnType<typeof createRoot>) {
  // In Electron the preload bridge already defined window.nekko; in the
  // web/Docker/Cloud editions this installs the HTTP/WS client (Cloud sends the
  // signed-in account's Bearer token). Either way the UI below is identical.
  ensureNekko();
  registerServiceWorker();
  startTelemetry();
  root.render(
    <React.StrictMode>
      <UpdateProvider>
        <App />
      </UpdateProvider>
    </React.StrictMode>,
  );
}

async function boot() {
  const root = createRoot(document.getElementById('root')!);
  // Only the hosted (Nekko Cloud) edition gates on sign-in; everything else
  // mounts straight away.
  if (await cloudAuthRequired()) {
    root.render(<CloudLogin onAuthed={() => startApp(root)} />);
  } else {
    startApp(root);
  }
}

void boot();
