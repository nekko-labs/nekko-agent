// A random port for an itest server that Node's fetch will actually connect to.
// fetch follows the browser "bad ports" list and refuses those ports outright,
// so a test that happened to pick 6000 (X11) waited 60 s on a server that was up
// the whole time. `offsets` keeps ports derived from the pick (pick + 400) off
// the list too.
const BLOCKED = new Set([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);

export const randomPort = (base, span, offsets = []) => {
  for (;;) {
    const port = base + Math.floor(Math.random() * span);
    if (![port, ...offsets.map((o) => port + o)].some((p) => BLOCKED.has(p))) return port;
  }
};
