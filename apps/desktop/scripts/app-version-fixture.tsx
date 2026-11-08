// Real About surface with a synthetic bridge, no engine or external effects.
const version = new URLSearchParams(location.search).get('version')!;
(window as any).nekko = {
  getAppInfo: async () => ({ version, platform: 'darwin', isPackaged: false }),
  onUpdateEvent: () => () => {},
};
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/components/AboutNekko'), import('../src/renderer/components/UpdateBanner'), import('../src/renderer/store')]).then(async ([React, { createRoot }, { AboutNekko }, { UpdateProvider }, { useStore }]) => {
  await import('@fontsource-variable/inter-tight');
  await import('@fontsource-variable/jetbrains-mono');
  await import('../src/renderer/styles.css');
  useStore.setState({ settings: { autoUpdate: false } } as any);
  document.body.style.background = 'var(--paper)';
  createRoot(document.getElementById('root')!).render(React.createElement(UpdateProvider, null, React.createElement(AboutNekko)));
  (window as any).versionFixtureReady = true;
});
