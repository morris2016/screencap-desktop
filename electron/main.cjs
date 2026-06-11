const { app, BrowserWindow, ipcMain, dialog, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const { LinkServer } = require('./linkserver.cjs');

const link = new LinkServer();

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    backgroundColor: '#0e1015',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  });
  win.removeMenu();
  // Renderer console → file, so field issues are diagnosable without DevTools.
  const logPath = path.join(app.getPath('temp'), 'screencap-studio-console.log');
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${message} (${sourceId}:${line})\n`);
    } catch {}
  });
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

// Display + window enumeration for the picker (id, name, thumbnail dataURL).
ipcMain.handle('get-capture-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    isScreen: s.id.startsWith('screen'),
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

ipcMain.handle('save-recording', async (e, arrayBuffer, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('videos'), suggestedName),
    filters: [{ name: 'Video', extensions: ['webm'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
  return filePath;
});

ipcMain.handle('save-screenshot', async (e, dataUrl) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('pictures'), `ScreenCap_${Date.now()}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return filePath;
});

ipcMain.handle('link-start', () => link.start(app.getPath('userData')));
ipcMain.handle('link-info', () => link.info());

// ---- Recording finalize: raw capture -> real MP4 via ffmpeg (video copy, audio -> AAC) ----
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG,
  'C:\\Users\\fame\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe',
  'ffmpeg',
].filter(Boolean);

function ffmpegPath() {
  for (const c of FFMPEG_CANDIDATES) {
    try {
      if (c === 'ffmpeg') return c; // resolved via PATH at spawn time
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function recordingsDir() {
  const dir = path.join(app.getPath('videos'), 'ScreenCap');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('finalize-recording', async (e, arrayBuffer, h264) => {
  const dir = recordingsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(dir, `.tmp_${stamp}.mkv`);
  fs.writeFileSync(tmp, Buffer.from(arrayBuffer));
  const ff = ffmpegPath();
  if (!ff || !h264) {
    // No ffmpeg or VP9 fallback capture: keep the raw container.
    const out = path.join(dir, `ScreenCap_${stamp}.webm`);
    fs.renameSync(tmp, out);
    return out;
  }
  const out = path.join(dir, `ScreenCap_${stamp}.mp4`);
  const { spawn } = require('child_process');
  return await new Promise((resolve) => {
    const p = spawn(ff, ['-y', '-i', tmp, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', out]);
    p.on('close', (code) => {
      try { fs.unlinkSync(tmp); } catch {}
      if (code === 0) resolve(out);
      else {
        // Remux failed: keep the raw so footage is never lost.
        const raw = path.join(dir, `ScreenCap_${stamp}.mkv`);
        try { fs.renameSync(tmp, raw); } catch {}
        resolve(raw);
      }
    });
    p.on('error', () => resolve(null));
  });
});

// ---- Recordings library ----
ipcMain.handle('library-list', () => {
  const dir = recordingsDir();
  return fs.readdirSync(dir)
    .filter((f) => !f.startsWith('.tmp_') && /\.(mp4|webm|mkv)$/i.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, path: path.join(dir, f), size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
});
ipcMain.handle('library-open', (e, p) => require('electron').shell.openPath(p));
ipcMain.handle('library-open-folder', () => require('electron').shell.openPath(recordingsDir()));
ipcMain.handle('library-delete', (e, p) => {
  if (path.dirname(p) === recordingsDir()) fs.unlinkSync(p);
  return true;
});

// ---- Desktop Go-LIVE: renderer ships timesliced capture chunks; ffmpeg transcodes to a
// conformant RTMP stream (libx264, 2s keyframes BY CONSTRUCTION, AAC). ----
let streamProc = null;
ipcMain.handle('stream-start', (e, url, key, bitrateK) => {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg not found' };
  if (streamProc) return { ok: false, error: 'already streaming' };
  const { spawn } = require('child_process');
  const target = `${url.replace(/\/$/, '')}/${key}`;
  streamProc = spawn(ff, [
    '-re', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-b:v', `${bitrateK}k`, '-maxrate', `${bitrateK}k`, '-bufsize', `${bitrateK * 2}k`,
    '-g', '60', '-keyint_min', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-f', 'flv', target,
  ]);
  const logPath = path.join(app.getPath('temp'), 'screencap-studio-stream.log');
  streamProc.stderr.on('data', (d) => {
    try { fs.appendFileSync(logPath, d.toString()); } catch {}
  });
  streamProc.on('close', (code) => {
    streamProc = null;
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('stream-ended', code ?? -1);
    }
  });
  return { ok: true };
});
ipcMain.on('stream-chunk', (e, chunk) => {
  if (streamProc?.stdin.writable) streamProc.stdin.write(Buffer.from(chunk));
});
ipcMain.handle('stream-stop', () => {
  if (streamProc) {
    try { streamProc.stdin.end(); } catch {}
  }
  return true;
});

app.whenReady().then(() => {
  createWindow();
  link.onStatus = (s) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('link-status', s);
  };
});
app.on('window-all-closed', () => {
  link.stop();
  app.quit();
});
