// The one renderer entry the end-to-end suite builds. Each scenario installs a
// synthetic window.nekko and mounts real renderer views; none reaches a host,
// daemon or network.
const scenarios: Record<string, () => Promise<unknown>> = {
  'command-center': () => import('../scripts/command-center-fixture'),
  'chat-finder': () => import('./scenarios/chat-finder'),
};

const name = new URLSearchParams(location.search).get('scenario') ?? '';
const load = scenarios[name] ?? (() => Promise.reject(new Error(`Unknown e2e scenario "${name}"`)));
load().catch((error) => {
  document.body.dataset.e2eError = String(error);
  throw error;
});
