const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const { LinkServer } = require('./linkserver.cjs');

// ONE disable-features list — a second appendSwitch('disable-features') call silently
// OVERWRITES this one and resurrects the WGC E_FAIL capture bug. Two bug classes killed here:
// 1) WGC capture backend (ProcessFrame E_FAIL floods after display-config changes) — force
//    the battle-tested DXGI duplication capturer.
// 2) Renderer background throttling (THE live-audio chop root cause, panel-verified
//    2026-06-12): when the studio window is occluded/minimized — which is exactly when the
//    user goes live — Chromium + Win11 EcoQoS demote the renderer hosting the whole audio
//    engine; the audio thread misses render quanta in ~55ms holes and both MediaRecorder
//    consumers inherit identical PTS gaps = hard mute slices on YouTube AND local takes.
app.commandLine.appendSwitch(
  'disable-features',
  'AllowWgcScreenCapturer,AllowWgcWindowCapturer,WebRtcAllowWgcDesktopCapturer,WebRtcAllowWgcScreenCapturer,WebRtcAllowWgcWindowCapturer,' +
    'IntensiveWakeUpThrottling,UseEcoQoSForBackgroundProcess',
);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const link = new LinkServer();

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    backgroundColor: '#0e1015',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      // Keeps rAF (compositor canvas captureStream) and page scheduling alive when the
      // window is covered — part of the live-audio-chop fix.
      backgroundThrottling: false,
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
    // aresample=async=1: normalizes the 30-48ms audio timestamp micro-jitter MediaRecorder
    // leaves even in clean takes (panel measurement).
    const p = spawn(ff, ['-y', '-i', tmp, '-c:v', 'copy', '-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', '-b:a', '192k', out]);
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

// ---- Desktop Go-LIVE: supervised ffmpeg with auto-restart, live health, and a watchdog.
// NO -re: live pipes are already real-time; -re double-throttled reads to 1.6fps and
// collapsed all nine field attempts ("Conversion failed!"). ----
const stream = {
  proc: null,
  wanted: false,        // user intent: stay live until they stop
  target: null,
  bitrateK: 4000,
  direct: false,        // ddagrab native screen capture (video never touches Chromium)
  micDevice: null,      // dshow device name → FULLY native audio (no Chromium in the path)
  fx: null,             // VoiceFx settings from the renderer → ffmpeg filter chain
  qsvBroken: false,     // QuickSync failed this session — fall back to libx264
  spawnMs: 0,           // watchdog startup-grace anchor
  awaitingFresh: false, // drop stale chunks until a fresh container header arrives
  attempts: 0,
  lastOkMs: 0,
  lastProgressMs: 0,
  lastSpeed: 1,
  slowSinceMs: 0,
  restartTimer: null,
  watchdog: null,
};

function sendAll(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...args);
}

// Broadcast voice chain in ffmpeg-NATIVE filters (panel-tuned 2026-06-12, validated on
// this machine: 0 gaps / locked 30fps / 45s acceptance run). Built from the studio's FX
// panel settings when provided; falls back to the tuned defaults.
function voiceChainFilter(fx) {
  const f = fx || {};
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const parts = ['aresample=async=1000:first_pts=0'];
  const trim = num(f.inputDb, 0);
  if (trim) parts.push(`volume=${trim}dB`);
  parts.push(`highpass=f=${num(f.lowCut, 80)}:poles=2`);
  if (f.denoise !== false) parts.push('afftdn=nr=10:nf=-47:tn=1');
  if (f.gate !== false) {
    const open = Math.pow(10, num(f.gateDb, -42) / 20).toFixed(4);
    parts.push(`agate=threshold=${open}:ratio=2:attack=10:release=300:range=0.0631:knee=6:detection=rms`);
  }
  if (f.deEss) parts.push('deesser=i=0.25:m=0.5:f=0.55');
  parts.push(`lowshelf=g=${num(f.eqLow, 1.5)}:f=120:width_type=q:w=0.7`);
  parts.push(`equalizer=f=250:width_type=q:w=1.0:g=${num(f.eqMud, -2.5)}`);
  parts.push(`equalizer=f=3000:width_type=q:w=1.0:g=${num(f.eqPresence, 3)}`);
  parts.push(`highshelf=g=${num(f.eqAir, 2)}:f=12000:width_type=q:w=0.7`);
  if (f.comp !== false) {
    const amt = num(f.compAmount, 0.35);
    const thr = Math.pow(10, (-18 - 17 * amt) / 20).toFixed(4);
    const ratio = (2 + 4 * amt).toFixed(1);
    // acompressor makeup is a LINEAR gain factor (1..64) — convert from dB.
    const makeup = Math.min(64, Math.max(1, Math.pow(10, num(f.makeupDb, 8) / 20))).toFixed(2);
    parts.push(`acompressor=threshold=${thr}:ratio=${ratio}:attack=5:release=150:knee=6:makeup=${makeup}`);
  }
  parts.push('alimiter=limit=0.891:attack=5:release=80:level=disabled');
  return parts.join(',');
}

function spawnStream() {
  const { spawn } = require('child_process');
  const ff = ffmpegPath();
  const logPath = path.join(app.getPath('temp'), 'screencap-studio-stream.log');
  let recentErr = [];
  // Direct mode: video is captured NATIVELY by ffmpeg (Desktop Duplication API via ddagrab)
  // and only mixer audio rides the pipe — Chromium's flaky WGC capture is out of the video
  // path entirely. Default mode: full A/V MediaRecorder stream over the pipe (scene compositing).
  // probesize/analyzeduration: the audio-only pipe trickles ~16KB/s — don't let the
  // demuxer probe stall startup (webm headers identify opus immediately).
  // Direct-mode audio, best-first:
  // (a) FULLY NATIVE (preferred): ffmpeg captures the mic itself via DirectShow and runs
  //     the voice chain in native filters — zero Chromium in the audio path, immune to
  //     renderer occlusion throttling BY CONSTRUCTION (the bug class that survived the
  //     flags on this machine). Verified: 45s acceptance run, 100% payload, 0 gaps, 30fps.
  // (b) pipe fallback (no mic in the studio): mixer audio over stdin as before.
  const nativeAudio = stream.direct && !!stream.micDevice;
  const audioIn = nativeAudio
    ? [
        '-f', 'dshow', '-audio_buffer_size', '50', '-thread_queue_size', '1024',
        '-i', `audio=${stream.micDevice}`,
      ]
    : [
        '-fflags', 'nobuffer', '-probesize', '65536', '-analyzeduration', '500000', '-i', 'pipe:0',
      ];
  const audioMap = ['-map', '[v]', '-map', nativeAudio ? '0:a' : '0:a?'];
  // Zero-copy GPU pipeline (preferred): the desktop renders on the Intel iGPU, so
  // ddagrab captures there and QuickSync encodes ON THE SAME DEVICE — video costs the
  // CPU ~nothing. x264 (4 threads, below-normal priority) remains as the automatic
  // fallback when QSV init fails.
  const useQsv = stream.direct && !stream.qsvBroken;
  const input = stream.direct
    ? useQsv
      ? [
          '-init_hw_device', 'd3d11va=dx', '-init_hw_device', 'qsv=qs@dx', '-filter_hw_device', 'dx',
          '-filter_complex', 'ddagrab=framerate=30,hwmap=derive_device=qsv:extra_hw_frames=16,format=qsv[v]',
          ...audioIn, ...audioMap,
        ]
      : [
          '-filter_complex', `ddagrab=framerate=30,hwdownload,format=bgra,scale='min(1920,iw)':-2[v]`,
          ...audioIn, ...audioMap,
        ]
    : ['-fflags', 'nobuffer', '-i', 'pipe:0'];
  const videoEnc = useQsv
    ? [
        '-c:v', 'h264_qsv', '-preset', 'fast',
        '-b:v', `${stream.bitrateK}k`, '-maxrate', `${stream.bitrateK}k`,
        '-bufsize', `${stream.bitrateK * 2}k`,
        '-g', '60', '-fps_mode', 'cfr',
      ]
    : [
        '-c:v', 'libx264', '-preset', 'superfast', '-tune', 'zerolatency',
        // Half the cores: x264 saturating all 8 starves Chromium's audio thread.
        '-threads', '4',
        // True CBR (nal-hrd padding): ABR undershoots on static desktops and YouTube
        // flags "bitrate lower than recommended". Steady-rate is the broadcast norm.
        '-b:v', `${stream.bitrateK}k`, '-minrate', `${stream.bitrateK}k`,
        '-maxrate', `${stream.bitrateK}k`, '-bufsize', `${stream.bitrateK * 2}k`,
        '-x264-params', 'nal-hrd=cbr',
        '-g', '60', '-keyint_min', '60', '-pix_fmt', 'yuv420p',
      ];
  const p = spawn(ff, [
    ...input,
    ...videoEnc,
    // Native audio: the full broadcast voice chain runs in ffmpeg filters (denoise, gate,
    // EQ, comp, limiter — from the studio's FX settings). Pipe audio keeps aresample
    // drift correction (two unsynchronized clocks).
    ...(stream.direct
      ? ['-af', nativeAudio ? voiceChainFilter(stream.fx) : 'aresample=async=1000:first_pts=0',
         '-c:a', 'aac', '-b:a', '160k', '-ar', '48000']
      : ['-c:a', 'aac', '-b:a', '160k', '-ar', '44100']),
    '-f', 'flv', stream.target,
  ]);
  p.usedQsv = useQsv;
  stream.proc = p;
  // Below-normal priority: ffmpeg gets all SPARE cpu but never preempts the audio
  // engine or UI. Combined with -threads this kills the live-session audio glitching.
  try { require('os').setPriority(p.pid, require('os').constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  stream.spawnMs = Date.now();
  stream.lastProgressMs = Date.now();
  stream.awaitingFresh = true; // gate stdin until a fresh container header arrives
  p.stdin.on('error', () => {});
  p.on('error', () => {});
  p.stderr.on('data', (d) => {
    const s = d.toString();
    recentErr = recentErr.concat(s.split('\n').filter(Boolean)).slice(-8);
    try { fs.appendFileSync(logPath, s); } catch {}
    // ANY frame= line is proof of life — startup lines read "bitrate=N/A speed=N/A"
    // and must still feed the stall detector (field bug: watchdog killed healthy startups).
    if (/frame=\s*\d+/.test(s)) stream.lastProgressMs = Date.now();
    // Health fields parsed individually, tolerating N/A during startup.
    const fps = s.match(/fps=\s*([\d.]+)/);
    const kbps = s.match(/bitrate=\s*([\d.]+)kbits\/s/);
    const speed = s.match(/speed=\s*([\d.]+)x/);
    if (speed) {
      stream.lastSpeed = parseFloat(speed[1]);
      sendAll('stream-health', {
        fps: fps ? parseFloat(fps[1]) : 0,
        kbps: kbps ? Math.round(parseFloat(kbps[1])) : 0,
        speed: stream.lastSpeed,
        attempts: stream.attempts,
      });
      // 30s of healthy streaming resets the restart budget (stable-streak rule).
      if (stream.lastSpeed >= 0.95) {
        if (!stream.lastOkMs) stream.lastOkMs = Date.now();
        if (Date.now() - stream.lastOkMs > 30_000) stream.attempts = 0;
      } else {
        stream.lastOkMs = 0;
      }
    }
  });
  p.on('close', (code) => {
    if (stream.proc !== p) return;
    stream.proc = null;
    const reason = recentErr
      .filter((l) => /error|fail|refused|denied|not found|Invalid|I\/O/i.test(l))
      .slice(-2).join(' | ');
    // QSV died on arrival (bad driver/no iGPU): flip to the x264 path immediately,
    // without consuming a supervised-restart attempt.
    if (stream.wanted && p.usedQsv && Date.now() - stream.spawnMs < 3_000) {
      stream.qsvBroken = true;
      spawnStream();
      sendAll('stream-resume');
      return;
    }
    if (stream.wanted) {
      scheduleRestart(reason || `exit ${code}`);
    } else {
      sendAll('stream-ended', code ?? 0, reason);
    }
  });
}

function scheduleRestart(reason) {
  stream.attempts++;
  const delays = [1_000, 2_000, 4_000, 8_000, 15_000];
  if (stream.attempts > delays.length) {
    stream.wanted = false;
    stopWatchdog();
    sendAll('stream-ended', -1, `gave up after ${delays.length} restarts (${reason})`);
    return;
  }
  const delay = delays[stream.attempts - 1];
  sendAll('stream-restarting', stream.attempts, reason, delay);
  stream.restartTimer = setTimeout(() => {
    if (!stream.wanted) return;
    spawnStream();
    sendAll('stream-resume'); // renderer restarts MediaRecorder => fresh container header
  }, delay);
}

function startWatchdog() {
  stopWatchdog();
  stream.watchdog = setInterval(() => {
    if (!stream.wanted || !stream.proc) return;
    // Startup grace: ffmpeg's speed= is a CUMULATIVE average that ramps 0.3x→1.0x over
    // ~15s (init cost amortizes in). Judging it before 20s kills healthy startups.
    if (Date.now() - stream.spawnMs < 20_000) return;
    const stalled = Date.now() - stream.lastProgressMs > 5_000;
    if (stream.lastSpeed < 0.9) {
      if (!stream.slowSinceMs) stream.slowSinceMs = Date.now();
    } else {
      stream.slowSinceMs = 0;
    }
    const tooSlow = stream.slowSinceMs && Date.now() - stream.slowSinceMs > 10_000;
    if (stalled || tooSlow) {
      try { stream.proc.kill(); } catch {}
      // close handler schedules the supervised restart
      stream.lastProgressMs = Date.now();
      stream.slowSinceMs = 0;
    }
  }, 2_000);
}

function stopWatchdog() {
  if (stream.watchdog) clearInterval(stream.watchdog);
  stream.watchdog = null;
  if (stream.restartTimer) clearTimeout(stream.restartTimer);
  stream.restartTimer = null;
}

ipcMain.handle('stream-start', (e, url, key, bitrateK, direct, micDevice, fx) => {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg not found — install it or set FFMPEG env var' };
  if (!/^rtmps?:\/\/.+/.test(url)) return { ok: false, error: 'URL must start with rtmp:// or rtmps://' };
  if (!key.trim()) return { ok: false, error: 'stream key is empty' };
  if (stream.proc) return { ok: false, error: 'already streaming' };
  stream.target = `${url.replace(/\/$/, '')}/${key.trim()}`;
  stream.bitrateK = bitrateK;
  stream.direct = !!direct;
  stream.micDevice = (direct && micDevice) || null;
  stream.fx = fx || null;
  stream.qsvBroken = false; // re-probe QuickSync each go-live
  stream.wanted = true;
  stream.attempts = 0;
  stream.lastOkMs = 0;
  spawnStream();
  startWatchdog();
  return { ok: true };
});
ipcMain.on('stream-chunk', (e, chunk) => {
  try {
    if (!stream.proc?.stdin.writable) return;
    const buf = Buffer.from(chunk);
    if (stream.awaitingFresh) {
      // A fresh MediaRecorder's first chunk starts with the EBML magic. Stale in-flight
      // chunks from the PREVIOUS recorder don't — and they poisoned restarted ffmpeg's
      // probe ("mp3 ... Invalid data", field bug). Drop until the new container begins.
      if (!(buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)) return;
      stream.awaitingFresh = false;
    }
    stream.proc.stdin.write(buf);
  } catch {}
});
ipcMain.handle('stream-stop', () => {
  stream.wanted = false;
  stopWatchdog();
  if (stream.proc) {
    try { stream.proc.stdin.end(); } catch {}
    // ddagrab never EOFs — direct mode must be killed, not waited out.
    if (stream.direct) {
      const p = stream.proc;
      setTimeout(() => { try { p.kill(); } catch {} }, 500);
    }
  }
  return true;
});

// ---- Session keep-awake: while recording/streaming, the OS must not power-throttle us.
let psbId = null;
ipcMain.on('session-active', (e, active) => {
  try {
    if (active && psbId === null) {
      psbId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!active && psbId !== null) {
      powerSaveBlocker.stop(psbId);
      psbId = null;
    }
  } catch {}
});

// ---- Voice FX assets: worklet code + wasm bytes for the renderer's RNNoise/gate chain.
// Served over IPC because fetch() can't load file:// URLs from the built renderer. ----
ipcMain.handle('voicefx-assets', () => {
  try {
    const base = path.dirname(require.resolve('@sapphi-red/web-noise-suppressor'));
    return {
      rnnoiseWorklet: fs.readFileSync(path.join(base, 'rnnoise', 'workletProcessor.js'), 'utf8'),
      rnnoiseWasm: fs.readFileSync(path.join(base, 'rnnoise_simd.wasm')),
    };
  } catch (e) {
    return { error: String(e) };
  }
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
