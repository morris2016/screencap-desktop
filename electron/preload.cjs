const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screencap', {
  getCaptureSources: () => ipcRenderer.invoke('get-capture-sources'),
  saveRecording: (buf, name) => ipcRenderer.invoke('save-recording', buf, name),
  saveScreenshot: (dataUrl) => ipcRenderer.invoke('save-screenshot', dataUrl),
  linkStart: () => ipcRenderer.invoke('link-start'),
  linkInfo: () => ipcRenderer.invoke('link-info'),
  onLinkStatus: (cb) => ipcRenderer.on('link-status', (e, s) => cb(s)),
});
