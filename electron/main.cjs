const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const { LinkServer } = require('./linkserver.cjs');
const { YouTubeService } = require('./youtube.cjs');

// ---- Run elevated (admin). An elevated process and its ffmpeg/wasaploop children are
// exempt from Windows background + EcoQoS throttling and can hold high scheduling priority,
// so capturing a GPU-heavy foreground app (Discord) no longer starves the capture when the
// Studio window loses focus — the root of the "breaks when I switch away" symptom. Relaunch
// once with RunAs; the --elevated guard prevents a loop.
if (process.platform === 'win32' && app.isPackaged && !process.argv.includes('--elevated')) {
  let elevated = false;
  try { require('child_process').execSync('net session', { stdio: 'ignore', windowsHide: true }); elevated = true; } catch {}
  if (!elevated) {
    let relaunched = false;
    try {
      const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const argList = [...process.argv.slice(1), '--elevated'].map(q).join(',');
      const r = require('child_process').spawnSync('powershell.exe', [
        '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `$env:ELECTRON_RUN_AS_NODE=$null; Start-Process -FilePath ${q(process.execPath)} ` +
          `-ArgumentList ${argList} -WorkingDirectory ${q(process.cwd())} -Verb RunAs -ErrorAction Stop`,
      ], { stdio: 'ignore', windowsHide: true });
      relaunched = r.status === 0; // UAC accepted → elevated instance launched
    } catch {}
    // Only hand off if the elevated copy actually started; otherwise (UAC declined / no
    // PowerShell) keep running non-elevated so the app always opens.
    if (relaunched) process.exit(0);
  }
}

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
  wantSystem: false,    // also capture system audio (WASAPI loopback) and mix it with the mic
  sysGainDb: 0,         // system-audio level trim in dB
  sysProc: null,        // the wasaploop child feeding system audio into ffmpeg stdin
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
function voiceChainFilter(fx, opts = {}) {
  const f = fx || {};
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  // Gentle wall-clock sync: async=1 with a 100ms hard-comp floor keeps audio locked to
  // its true capture time and only nudges on large drift — NOT the aggressive async=1000
  // stretch that broke the voice when video ran a few % under realtime (capture-bound).
  // opts.limiter=false omits the final limiter (when this chain feeds an amix that limits).
  const parts = [];
  if (opts.aresample !== false) parts.push('aresample=async=1:min_hard_comp=0.100:first_pts=0');
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
  if (opts.limiter !== false) parts.push('alimiter=limit=0.891:attack=5:release=80:level=disabled');
  return parts.join(',');
}

// Path to the native WASAPI loopback capturer (system audio). Dev: project/native/.
function wasaplooPath() {
  const candidates = [
    path.join(__dirname, '..', 'native', 'wasaploop.exe'),
    path.join(process.resourcesPath || '', 'native', 'wasaploop.exe'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

/**
 * Build the native audio half of an ffmpeg capture: dshow mic and/or WASAPI-loopback system
 * audio, mixed in-filter. Returns { inputs, filterSegs, mapLabel, usePipe }. usePipe=true means
 * the caller must pipe wasaploop's stdout into ffmpeg's stdin (the system-audio source).
 */
function buildNativeAudio({ micDevice, wantSystem, fx, sysGainDb }) {
  const inputs = [];
  const segs = [];
  let n = 0, mi = -1, si = -1;
  if (micDevice) {
    inputs.push('-f', 'dshow', '-audio_buffer_size', '80', '-thread_queue_size', '4096', '-rtbufsize', '64M', '-i', `audio=${micDevice}`);
    mi = n++;
  }
  if (wantSystem && wasaplooPath()) {
    inputs.push('-f', 'f32le', '-ar', '48000', '-ac', '2', '-thread_queue_size', '4096', '-i', 'pipe:0');
    si = n++;
  }
  const sdb = typeof sysGainDb === 'number' ? sysGainDb : 0;
  const lim = 'alimiter=limit=0.891:attack=5:release=80:level=disabled';
  let mapLabel = null;
  if (mi >= 0 && si >= 0) {
    segs.push(`[${mi}:a]${voiceChainFilter(fx, { limiter: false })}[m]`);
    segs.push(`[${si}:a]aresample=async=1:first_pts=0,volume=${sdb}dB[s]`);
    segs.push(`[m][s]amix=inputs=2:duration=longest:normalize=0,${lim}[aout]`);
    mapLabel = '[aout]';
  } else if (mi >= 0) {
    segs.push(`[${mi}:a]${voiceChainFilter(fx)}[aout]`);
    mapLabel = '[aout]';
  } else if (si >= 0) {
    segs.push(`[${si}:a]aresample=async=1:first_pts=0,volume=${sdb}dB,${lim}[aout]`);
    mapLabel = '[aout]';
  }
  return { inputs, filterSegs: segs, mapLabel, usePipe: si >= 0 };
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
  // FULLY NATIVE A/V (direct mode): ffmpeg captures the screen (ddagrab), the mic (dshow),
  // AND system audio (WASAPI loopback via wasaploop on stdin), mixing mic+system in-filter.
  // Zero Chromium in the path — immune to renderer/occlusion throttling by construction.
  // Non-direct: full A/V MediaRecorder webm over the pipe (scene compositing).
  const useQsv = stream.direct && !stream.qsvBroken;
  let input, audioOut, useSysPipe = false;
  if (stream.direct) {
    const na = buildNativeAudio({
      micDevice: stream.micDevice,
      wantSystem: stream.wantSystem,
      fx: stream.fx,
      sysGainDb: stream.sysGainDb,
    });
    useSysPipe = na.usePipe;
    // Downscale to 1080p (keep aspect): a 1440p/4K desktop captured natively makes YouTube
    // demand ~23500kbps; at the uplink-feasible ~6000kbps that looks blocky. Sharp 1080p
    // is the right target. scale_qsv stays on-GPU (zero-copy).
    const vfilter = useQsv
      ? 'ddagrab=framerate=30,hwmap=derive_device=qsv:extra_hw_frames=16,format=qsv,scale_qsv=w=-1:h=1080[v]'
      : `ddagrab=framerate=30,hwdownload,format=bgra,scale='min(1920,iw)':-2[v]`;
    const hw = useQsv ? ['-init_hw_device', 'd3d11va=dx', '-init_hw_device', 'qsv=qs@dx', '-filter_hw_device', 'dx'] : [];
    const fc = [vfilter, ...na.filterSegs].join(';');
    input = [...hw, ...na.inputs, '-filter_complex', fc, '-map', '[v]'];
    if (na.mapLabel) input.push('-map', na.mapLabel);
    audioOut = na.mapLabel ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'] : [];
  } else {
    input = ['-fflags', 'nobuffer', '-i', 'pipe:0'];
    audioOut = ['-af', 'aresample=async=1000:first_pts=0', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100'];
  }
  const videoEnc = useQsv
    ? [
        '-c:v', 'h264_qsv', '-preset', 'veryfast',
        '-b:v', `${stream.bitrateK}k`, '-maxrate', `${stream.bitrateK}k`,
        '-bufsize', `${stream.bitrateK * 2}k`,
        // passthrough (NOT cfr): keep ddagrab's true capture timestamps so audio stays
        // wall-clock-synced instead of being stretched to a strict 30fps clock the
        // capture can't sustain under GPU load — that stretch was the "shaky voice".
        '-fps_mode', 'passthrough',
        // Keyframes by TIME (every 2s), not frame count — a frame-based GOP becomes a
        // 6s+ keyframe interval if fps dips (YouTube: "keyframe frequency 6.0s" error).
        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-g', '60',
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
    ...audioOut,
    '-f', 'flv', stream.target,
  ]);
  p.usedQsv = useQsv;
  stream.proc = p;
  // System audio: pipe the native WASAPI loopback capturer into ffmpeg's stdin.
  stopSysAudio();
  if (useSysPipe) {
    const wp = wasaplooPath();
    if (wp) {
      const sysProc = spawn(wp, [], { stdio: ['ignore', 'pipe', 'ignore'] });
      sysProc.on('error', () => {});
      sysProc.stdout.on('error', () => {});
      try { sysProc.stdout.pipe(p.stdin); } catch {}
      stream.sysProc = sysProc;
    }
  }
  // Priority by mode. NATIVE mode: ffmpeg IS the capture+encode+audio, so it must run
  // HIGH — otherwise Windows background-throttles our process the instant the app loses
  // foreground, the ddagrab grab collapses to ~0.5x, and the audio shreds (field bug:
  // "clean when focused, breaks when I switch away"). PIPE mode: the renderer's audio
  // engine is the critical path, so keep ffmpeg below-normal to not preempt it.
  try {
    const os = require('os');
    os.setPriority(p.pid, stream.direct ? os.constants.priority.PRIORITY_HIGH : os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
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
    // Only restart for a SUSTAINED severe slowdown — a stream running slightly behind
    // (0.8–0.95x) is still live and "Excellent" on YouTube's side; killing it thrashes
    // the RTMP connection and makes things worse than just letting it run.
    if (stream.lastSpeed < 0.8) {
      if (!stream.slowSinceMs) stream.slowSinceMs = Date.now();
    } else {
      stream.slowSinceMs = 0;
    }
    const tooSlow = stream.slowSinceMs && Date.now() - stream.slowSinceMs > 20_000;
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

function stopSysAudio() {
  if (stream.sysProc) {
    try { stream.sysProc.kill(); } catch {}
    stream.sysProc = null;
  }
}

ipcMain.handle('stream-start', (e, url, key, bitrateK, direct, micDevice, fx, audio) => {
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
  stream.wantSystem = !!(direct && audio && audio.system);
  stream.sysGainDb = (audio && typeof audio.sysGainDb === 'number') ? audio.sysGainDb : 0;
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
  stopSysAudio();
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

// ---- Native recording: the throttle-proof pipeline, to disk. Same ddagrab/QSV video +
// dshow mic + ffmpeg voice chain as native live — recordings survive a minimized window
// because no Chromium process carries the media. Runs fine alongside a live stream
// (second QSV session). 'q' on stdin = clean ffmpeg shutdown = intact file.
const nrec = { proc: null, tmp: null, out: null, stopping: false, sysProc: null };
ipcMain.handle('native-record-start', (e, micDevice, fx, audio) => {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg not found' };
  if (nrec.proc) return { ok: false, error: 'already recording' };
  const { spawn } = require('child_process');
  const dir = recordingsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  nrec.tmp = path.join(dir, `.live_${stamp}.mkv`);
  nrec.out = path.join(dir, `ScreenCap_${stamp}.mp4`);
  nrec.stopping = false;
  const na = buildNativeAudio({
    micDevice,
    wantSystem: !!(audio && audio.system),
    fx,
    sysGainDb: (audio && typeof audio.sysGainDb === 'number') ? audio.sysGainDb : 0,
  });
  const fc = ['ddagrab=framerate=30,hwmap=derive_device=qsv:extra_hw_frames=16,format=qsv[v]', ...na.filterSegs].join(';');
  const p = spawn(ff, [
    '-init_hw_device', 'd3d11va=dx', '-init_hw_device', 'qsv=qs@dx', '-filter_hw_device', 'dx',
    ...na.inputs,
    '-filter_complex', fc,
    '-map', '[v]', ...(na.mapLabel ? ['-map', na.mapLabel] : []),
    '-c:v', 'h264_qsv', '-preset', 'fast', '-b:v', '8000k', '-maxrate', '8000k',
    '-bufsize', '16000k', '-g', '60', '-fps_mode', 'passthrough',
    ...(na.mapLabel ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : []),
    '-y', nrec.tmp,
  ]);
  // HIGH priority: native recorder must survive the app being backgrounded (same
  // background-throttling that crashed the live capture when the app lost focus).
  try { require('os').setPriority(p.pid, require('os').constants.priority.PRIORITY_HIGH); } catch {}
  p.stdin.on('error', () => {});
  p.on('error', () => {});
  // System audio: pipe the native WASAPI loopback capturer into ffmpeg's stdin.
  if (nrec.sysProc) { try { nrec.sysProc.kill(); } catch {} nrec.sysProc = null; }
  if (na.usePipe) {
    const wp = wasaplooPath();
    if (wp) {
      const sysProc = spawn(wp, [], { stdio: ['ignore', 'pipe', 'ignore'] });
      sysProc.on('error', () => {});
      sysProc.stdout.on('error', () => {});
      try { sysProc.stdout.pipe(p.stdin); } catch {}
      nrec.sysProc = sysProc;
    }
  }
  const spawnedAt = Date.now();
  p.on('close', () => {
    if (nrec.proc !== p) return;
    nrec.proc = null;
    // Died on arrival (QSV/dshow failure) without a stop request: tell the renderer to
    // fall back to the legacy MediaRecorder path.
    if (!nrec.stopping && Date.now() - spawnedAt < 3_000) {
      try { fs.unlinkSync(nrec.tmp); } catch {}
      sendAll('native-record-failed');
    }
  });
  nrec.proc = p;
  nrec.usePipe = na.usePipe;
  return { ok: true };
});
ipcMain.handle('native-record-stop', async () => {
  const p = nrec.proc;
  if (!p) return null;
  nrec.stopping = true;
  // Stop system audio first so it stops feeding stdin, then stop ffmpeg.
  if (nrec.sysProc) { try { nrec.sysProc.kill(); } catch {} nrec.sysProc = null; }
  const closed = new Promise((resolve) => p.on('close', resolve));
  // When stdin carries system-audio PCM we can't send 'q' there — kill (mkv remuxes
  // losslessly, verified). Without system audio, 'q' for a clean shutdown, kill as backstop.
  if (!nrec.usePipe) { try { p.stdin.write('q'); } catch {} }
  const backstop = setTimeout(() => { try { p.kill(); } catch {} }, nrec.usePipe ? 300 : 1_500);
  await closed;
  clearTimeout(backstop);
  nrec.proc = null;
  // Both tracks are already final — pure remux into a real MP4.
  const ff = ffmpegPath();
  const ok = await new Promise((resolve) => {
    const { spawn } = require('child_process');
    const r = spawn(ff, ['-y', '-i', nrec.tmp, '-c', 'copy', '-movflags', '+faststart', nrec.out]);
    r.on('close', (c) => resolve(c === 0));
    r.on('error', () => resolve(false));
  });
  if (ok) {
    try { fs.unlinkSync(nrec.tmp); } catch {}
    return nrec.out;
  }
  return nrec.tmp; // raw kept — footage never lost
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

// ---- YouTube Live integration (OAuth + broadcast control + chat/moderation).
// Lazy singleton: constructed on first use, after app is ready (safeStorage/userData). ----
let _yt = null;
function yt() {
  if (!_yt) _yt = new YouTubeService();
  return _yt;
}
// Uniform wrapper: every yt-* call returns {ok, data}|{ok:false, error, reason} so the
// renderer never has to try/catch IPC and quota errors surface cleanly.
function ytHandle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return { ok: true, data: await fn(yt(), ...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err), reason: err.reason || null };
    }
  });
}
ipcMain.handle('open-external', (e, url) => {
  if (/^https:\/\//.test(url)) require('electron').shell.openExternal(url);
});
ytHandle('yt-status', (s) => s.getStatus());
ytHandle('yt-set-credentials', (s, id, secret) => s.setCredentials(id, secret));
ytHandle('yt-sign-in', (s) => s.signIn());
ytHandle('yt-sign-out', (s) => s.signOut());
ytHandle('yt-list-broadcasts', (s) => s.listBroadcasts());
ytHandle('yt-create-broadcast', (s, opts) => s.createBroadcast(opts));
ytHandle('yt-prepare-stream', (s, broadcastId) => s.prepareStream(broadcastId));
ytHandle('yt-prepare-live', (s, opts) => s.prepareLive(opts));
ytHandle('yt-stream-health', (s, streamId) => s.streamHealth(streamId));
ytHandle('yt-broadcast-status', (s, broadcastId) => s.getBroadcastStatus(broadcastId));
ytHandle('yt-transition', (s, broadcastId, status) => s.transition(broadcastId, status));
ytHandle('yt-set-thumbnail', (s, broadcastId, filePath) => s.setThumbnail(broadcastId, filePath));
ytHandle('yt-chat-send', (s, liveChatId, text) => s.chatSend(liveChatId, text));
ytHandle('yt-chat-delete', (s, messageId) => s.chatDelete(messageId));
ytHandle('yt-chat-ban', (s, liveChatId, channelId, seconds) => s.ban(liveChatId, channelId, seconds));
ytHandle('yt-chat-add-mod', (s, liveChatId, channelId) => s.addModerator(liveChatId, channelId));
ipcMain.on('yt-chat-start', (e, liveChatId) => {
  yt().chatStart(liveChatId, (msgs) => sendAll('yt-chat-messages', msgs));
});
ipcMain.on('yt-chat-stop', () => yt().chatStop());

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
