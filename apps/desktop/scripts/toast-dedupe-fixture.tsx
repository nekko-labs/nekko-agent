// The real toast stack with a synthetic bridge: one error pushed three times.
(window as any).nekko = {};
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/components/Toasts'), import('../src/renderer/store')]).then(async ([React, { createRoot }, { Toasts }, { useStore }]) => {
  await import('@fontsource-variable/geist');
  await import('@fontsource-variable/geist-mono');
  await import('../src/renderer/styles.css');
  document.body.style.background = 'var(--paper)';
  createRoot(document.getElementById('root')!).render(React.createElement(Toasts));
  const { pushToast } = useStore.getState();
  for (let i = 0; i < 3; i++) pushToast('error', 'Could not open Simulator');
  (window as any).toastFixtureReady = true;
});
