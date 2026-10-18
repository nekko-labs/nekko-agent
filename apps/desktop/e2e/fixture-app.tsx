// The one renderer entry the end-to-end suite builds. Each scenario installs a
// synthetic window.nekko and mounts real renderer views; none reaches a host,
// daemon or network.
function load(name: string): Promise<unknown> {
  // An explicit switch: the name from the URL only ever picks a fixed import.
  switch (name) {
    case 'command-center': return import('../scripts/command-center-fixture');
    case 'chat-finder': return import('./scenarios/chat-finder');
    default: return Promise.reject(new Error(`Unknown e2e scenario "${name}"`));
  }
}

load(new URLSearchParams(location.search).get('scenario') ?? '').catch((error) => {
  document.body.dataset.e2eError = String(error);
  throw error;
});
