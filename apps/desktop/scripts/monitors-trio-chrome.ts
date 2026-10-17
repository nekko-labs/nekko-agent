// Imported first by monitors-trio-fixture so displays.ts sees a desktop shell
// with three synthetic screens. Inert: no window is ever opened or moved.
const displays = {
  placement: 'empty-first',
  displays: [
    { id: '1', label: '1', bounds: { x: 0, y: 0, width: 2560, height: 1440 }, main: true, primary: true, enabled: true, self: true, scaleFactor: 1 },
    { id: '2', label: '2', bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, main: false, primary: false, enabled: true, self: false, scaleFactor: 1 },
    { id: '3', label: '3', bounds: { x: 4480, y: 0, width: 1080, height: 1920 }, main: false, primary: false, enabled: false, self: false, scaleFactor: 1 },
  ],
};
Object.assign(window, {
  nekkoChrome: {
    platform: 'win32', titleBarHeight: 38, setTitleBarOverlay() {}, serviceControl: async () => ({ state: 'stopped' }), reportNotificationVisibility() {},
    displays: { displayId: null, list: async () => displays, toggle: async () => displays, setPlacement: async () => displays, report() {}, claim: async () => 'main', onChange: () => () => {}, onPlaced: () => () => {} },
  },
});
