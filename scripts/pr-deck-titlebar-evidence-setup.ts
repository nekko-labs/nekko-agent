// Runs before any renderer module: fake desktop chrome (Windows) and an inert bridge.
Object.assign(window, {
  nekkoChrome: { platform: 'win32', titleBarHeight: 38, setTitleBarOverlay() {}, serviceControl: () => Promise.resolve(null) },
  nekko: new Proxy({}, { get: (_, k: string) => k === 'getAppInfo' ? () => Promise.resolve({ version: '0.8.1', edition: 'desktop' }) : k.startsWith('on') ? () => () => {} : () => Promise.resolve(null) }),
});
localStorage.clear();
