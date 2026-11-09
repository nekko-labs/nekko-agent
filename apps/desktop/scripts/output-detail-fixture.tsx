// Real Customize controls, synthetic settings, no host or external side effects.
import defaultsFile from '../../../crates/nekko-settings/src/defaults.json';
const settings = { ...defaultsFile.defaults, providers: [], workspaceFolders: [], workspaces: [] };
const patches: unknown[] = [];
(window as any).nekko = {
  updateSettings: async (patch: unknown) => { patches.push(patch); return { ...Object.assign(settings, patch) }; },
};
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/components/CustomizeExperience'), import('../src/renderer/store'), import('../src/renderer/components/ModeViews')]).then(async ([React, { createRoot }, { CustomizeExperience, openCustomize }, { useStore }, { ModeSwitch }]) => {
  await import('@fontsource-variable/geist');
  await import('@fontsource-variable/geist-mono');
  await import('../src/renderer/styles.css');
  localStorage.setItem('nekko.simpleChoices', JSON.stringify({ asks: 'hide', cost: 'show' }));
  useStore.setState({ settings, settingsLoaded: true } as any);
  useStore.getState().applyTheme();
  const root = createRoot(document.getElementById('root')!);
  root.render(React.createElement(CustomizeExperience));
  (window as any).outputFixture = { patches, store: useStore, openCustomize, showMode: () => root.render(React.createElement('div', { style: { padding: 24 } }, React.createElement(ModeSwitch, { labels: true }))) };
  setTimeout(openCustomize, 100);
});
