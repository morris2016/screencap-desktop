const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screencap', {
  saveRecording: (arrayBuffer, suggestedName) =>
    ipcRenderer.invoke('save-recording', arrayBuffer, suggestedName),
});
