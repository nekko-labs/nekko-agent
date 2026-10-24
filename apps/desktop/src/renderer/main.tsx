import React from 'react';
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
import { playSplash } from './splash.js';
import { isScreenWindow } from './displays.js';

// Resolve the system preference before mounting even the loading or login UI.
useStore.getState().applyTheme();

// The startup splash plays over the app and zooms through once settings have
// loaded, so it opens onto the real app rather than the loading screen.
if (!isScreenWindow) {
  const loaded = new Promise<void>((resolve) => {
    if (useStore.getState().settingsLoaded) return resolve();
    const stop = useStore.subscribe((s) => { if (s.settingsLoaded) { stop(); requestAnimationFrame(() => resolve()); } });
  });
  playSplash(loaded);
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
