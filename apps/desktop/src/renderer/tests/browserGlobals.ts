/**
 * The few browser globals the renderer modules touch at import and first render,
 * so a test can server-render real components (ChatPane, App) against the real
 * store. Import it before any renderer module. Host calls (`window.nekko.*`)
 * never settle, so effects that would load data simply wait.
 */
const storage = new Map<string, string>();
const memoryStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
};
const noop = () => {};
const media = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });
const g = globalThis as unknown as Record<string, unknown>;
if (!g.window) {
  g.window = {
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    matchMedia: media,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: noop,
    nekko: new Proxy({}, { get: () => () => new Promise(noop) }),
  };
}
g.localStorage ??= memoryStorage;
g.sessionStorage ??= memoryStorage;
const win = g.window as Record<string, unknown>;
win.localStorage ??= g.localStorage;
win.sessionStorage ??= g.sessionStorage;
g.document ??= { addEventListener: noop, removeEventListener: noop, hidden: false, documentElement: { dataset: {}, style: { setProperty: noop } }, body: {} };
g.matchMedia ??= media;

export {};
