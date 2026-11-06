// The real page zoom call for the text size sandboxes: webFrame in a sandboxed
// preload, which layout-evidence-fixture.tsx hands to its stub window bridge.
const { contextBridge, webFrame } = require('electron');
contextBridge.exposeInMainWorld('nekkoTestZoom', (factor) => webFrame.setZoomFactor(factor));
