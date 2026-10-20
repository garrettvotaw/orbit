const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('orbit', {
  onEvent(cb) {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('orbit:event', handler);
    return () => ipcRenderer.removeListener('orbit:event', handler);
  },
  command(cmd) {
    return ipcRenderer.invoke('orbit:command', cmd);
  },
  request(req) {
    return ipcRenderer.invoke('orbit:request', req);
  },
});
