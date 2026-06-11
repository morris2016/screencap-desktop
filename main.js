const { app, BrowserWindow, session, desktopCapturer, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  // Screen share: hand getDisplayMedia the primary screen WITH Windows loopback system audio.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  });

  win.removeMenu();
  win.loadFile('index.html');
}

// Save recordings via a native dialog (renderer sends the bytes).
ipcMain.handle('save-recording', async (e, arrayBuffer, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('videos'), suggestedName),
    filters: [{ name: 'Video', extensions: ['webm'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
  return filePath;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
