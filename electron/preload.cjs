const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screencap', {
  getCaptureSources: () => ipcRenderer.invoke('get-capture-sources'),
  saveRecording: (buf, name) => ipcRenderer.invoke('save-recording', buf, name),
  saveScreenshot: (dataUrl) => ipcRenderer.invoke('save-screenshot', dataUrl),
  linkStart: () => ipcRenderer.invoke('link-start'),
  linkInfo: () => ipcRenderer.invoke('link-info'),
  onLinkStatus: (cb) => ipcRenderer.on('link-status', (e, s) => cb(s)),
  finalizeRecording: (buf, h264) => ipcRenderer.invoke('finalize-recording', buf, h264),
  libraryList: () => ipcRenderer.invoke('library-list'),
  libraryOpen: (p) => ipcRenderer.invoke('library-open', p),
  libraryOpenFolder: () => ipcRenderer.invoke('library-open-folder'),
  libraryDelete: (p) => ipcRenderer.invoke('library-delete', p),
  streamStart: (url, key, bitrateK) => ipcRenderer.invoke('stream-start', url, key, bitrateK),
  streamChunk: (chunk) => ipcRenderer.send('stream-chunk', chunk),
  streamStop: () => ipcRenderer.invoke('stream-stop'),
  onStreamEnded: (cb) => ipcRenderer.on('stream-ended', (e, code) => cb(code)),
});
