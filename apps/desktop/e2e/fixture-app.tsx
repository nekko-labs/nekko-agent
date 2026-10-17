// The one renderer entry the end-to-end suite builds. Each scenario installs a
// synthetic window.nekko and mounts real renderer views; none reaches a host,
// daemon or network.
const scenarios = new Map<string, () => Promise<unknown>>([
  ['command-center', () => import('../scripts/command-center-fixture')],
  ['chat-finder', () => import('./scenarios/chat-finder')],
]);

// Only a registered name is ever called; anything else from the URL is an error.
const name = new URLSearchParams(location.search).get('scenario') ?? '';
const load = scenarios.get(name);
(load ? load() : Promise.reject(new Error(`Unknown e2e scenario "${name}"`))).catch((error) => {
  document.body.dataset.e2eError = String(error);
  throw error;
});
