// Imported first by view-option-groups-fixture so displays.ts sees a desktop
// shell. `?screens=2` adds a second screen; desktops are always on, with the
// mode already chosen, so both "Open new agents" groups show. Inert: no window
// is ever opened or moved.
const two = new URLSearchParams(location.search).get('screens') === '2';
const screen = (id: string, x: number, main: boolean) => ({ id, label: id, bounds: { x, y: 0, width: 1728, height: 1117 }, main, primary: main, enabled: main, self: main, scaleFactor: 2 });
const desk = (n: number) => ({ id: `space-${n}`, label: String(n), current: n === 1, main: n === 1, enabled: n === 1, waiting: false, self: n === 1 });
const displays = {
  placement: 'empty-first',
  displays: two ? [screen('1', 0, true), screen('2', 1728, false)] : [screen('1', 0, true)],
  spaces: { mode: 'switch', access: true, desktops: [desk(1), desk(2), desk(3)] },
};
Object.assign(window, {
  nekkoChrome: {
    platform: 'darwin', titleBarHeight: 38, setTitleBarOverlay() {}, serviceControl: async () => ({ state: 'stopped' }), reportNotificationVisibility() {},
    displays: { displayId: null, list: async () => displays, toggle: async () => displays, toggleDesktop: async () => displays, setPlacement: async () => displays, setSpacesMode: async () => displays, report() {}, claim: async () => 'main', onChange: () => () => {}, onPlaced: () => () => {} },
  },
});
