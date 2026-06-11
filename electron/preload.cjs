const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screencap', {
  getCaptureSources: () => ipcRenderer.invoke('get-capture-sources'),
  saveRecording: (buf, name) => ipcRenderer.invoke('save-recording', buf, name),
  saveScreenshot: (dataUrl) => ipcRenderer.invoke('save-screenshot', dataUrl),
});
