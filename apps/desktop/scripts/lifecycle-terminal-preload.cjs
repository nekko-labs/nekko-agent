const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lifecycleTerminal', {
  list: () => ipcRenderer.invoke('lifecycle:terminal:list'),
  close: id => ipcRenderer.invoke('lifecycle:terminal:close', id),
  probe: () => ipcRenderer.invoke('lifecycle:terminal:probe'),
});
