/*
 * audiometer.cjs — 3-POINT LIVE AUDIO METER (standalone, no Electron)
 * ============================================================================
 * Run this from a terminal WHILE real audio is playing (e.g. Discord voice +
 * your mic) to find out what eats the INTERNAL/system audio when the mic opens.
 *
 * It simultaneously meters three levels in dBFS as a synchronized time series:
 *   INTERNAL/APP = the system audio captured by wasaploop (the Discord source)
 *   MIC          = the microphone input (via ffmpeg dshow)
 *   MIX          = the FINAL mixed bus exactly as buildNativeAudio produces it
 * and at the end prints a VERDICT: does INTERNAL drop when the MIC is active
 * (ducking?), and WHERE — already low at the wasaploop source (external OS /
 * Discord communications ducking) or flat at source but low in the mix (us).
 *
 * USAGE:
 *   node scripts\audiometer.cjs --mic "Headset Microphone (Realtek(R) Audio)" --pid 0 --secs 30
 *
 * ARGS:
 *   --mic "<dshow device name>"  default "Headset Microphone (Realtek(R) Audio)"
 *   --pid <number|0>             0 = all-system endpoint loopback (default 0)
 *   --secs <N>                   capture duration seconds (default 30)
 *   --no-mix                     skip the mixed-bus tap
 *
 * NOTE: ONE wasaploop is spawned; its stdout is tee'd in Node to BOTH the
 * INTERNAL meter AND the MIX ffmpeg's stdin, so we never open the same
 * process/endpoint loopback twice.
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// CLI args (simple parser)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { mic: 'Headset Microphone (Realtek(R) Audio)', pid: 0, secs: 30, mix: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mic') out.mic = argv[++i];
    else if (a === '--pid') out.pid = parseInt(argv[++i], 10) || 0;
    else if (a === '--secs') out.secs = parseFloat(argv[++i]) || 30;
    else if (a === '--no-mix') out.mix = false;
  }
  if (!isFinite(out.secs) || out.secs <= 0) out.secs = 30;
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Resolve binaries — fail loudly if missing
// ---------------------------------------------------------------------------
function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG,
    'C:\\Users\\fame\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe',
    'ffmpeg',
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c === 'ffmpeg') return c; // assume on PATH
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}
function resolveWasaploop() {
  const candidates = [
    path.join('C:\\Users\\fame\\Documents\\bin\\screencap-desktop', 'native', 'wasaploop.exe'),
    path.join(process.resourcesPath || '', 'native', 'wasaploop.exe'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

const FFMPEG = resolveFfmpeg();
const WASAPLOOP = resolveWasaploop();
if (!FFMPEG) { console.error('FATAL: ffmpeg not found. Set FFMPEG env var or install the WinGet Gyan.FFmpeg build.'); process.exit(1); }
if (!WASAPLOOP) { console.error('FATAL: wasaploop.exe not found in native/ (project or resourcesPath).'); process.exit(1); }

// ---------------------------------------------------------------------------
// Audio format constants — f32le, 48000 Hz, 2ch
// ---------------------------------------------------------------------------
const SR = 48000;
const CH = 2;
const WINDOW_SEC = 0.1;                                  // 100 ms metering window
const FLOATS_PER_WINDOW = Math.round(SR * WINDOW_SEC * CH); // 9600 floats
const BYTES_PER_WINDOW = FLOATS_PER_WINDOW * 4;          // 38400 bytes
const DB_FLOOR = -120;

// dBFS of a linear amplitude (0..1). Guards value<=0 and NaN.
function toDb(value) {
  if (!(value > 0) || !isFinite(value)) return DB_FLOOR;
  const db = 20 * Math.log10(value);
  if (!isFinite(db) || db < DB_FLOOR) return DB_FLOOR;
  return db;
}

// ---------------------------------------------------------------------------
// A metering tap: buffers leftover bytes across data events, emits {rms,peak}
// in dBFS for every full 100 ms window via onWindow callback.
// ---------------------------------------------------------------------------
function makeMeter(label, onWindow) {
  let buf = Buffer.alloc(0);
  // latest computed values (dBFS) — sampled by the printer/sampler timer
  const state = { label, rms: DB_FLOOR, peak: DB_FLOOR, gotData: false };
  function feed(chunk) {
    state.gotData = true;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= BYTES_PER_WINDOW) {
      let sumSq = 0;
      let peak = 0;
      for (let off = 0; off < BYTES_PER_WINDOW; off += 4) {
        const s = buf.readFloatLE(off);
        if (!isFinite(s)) continue;            // guard NaN/Inf in stream
        const a = Math.abs(s);
        if (a > peak) peak = a;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / FLOATS_PER_WINDOW);
      state.rms = toDb(rms);
      state.peak = toDb(peak);
      if (onWindow) onWindow(state.rms, state.peak);
      buf = buf.subarray(BYTES_PER_WINDOW);
    }
  }
  return { state, feed };
}

// ---------------------------------------------------------------------------
// Build child processes
// ---------------------------------------------------------------------------
const children = [];
function track(p, name) {
  if (!p) return p;
  p.on('error', (e) => { /* never crash on a dead/failed child */ if (!shuttingDown) console.error(`[${name}] spawn error: ${e.message}`); });
  children.push({ p, name });
  return p;
}

// TAP 1 INTERNAL: ONE wasaploop. stdout f32le/48k/2ch. Tee'd to internal meter
// (+ MIX ffmpeg stdin below). pid 0 => omit arg.
const wlArgs = ARGS.pid ? [String(ARGS.pid)] : [];
const wasap = track(spawn(WASAPLOOP, wlArgs, { stdio: ['ignore', 'pipe', 'ignore'] }), 'wasaploop');

const internalMeter = makeMeter('INTERNAL', null);
if (wasap && wasap.stdout) {
  wasap.stdout.on('error', () => {});
  wasap.stdout.on('data', (d) => internalMeter.feed(d));
}

// TAP 2 MIC: ffmpeg dshow -> f32le/48k/2ch on stdout.
const micArgs = [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'dshow', '-audio_buffer_size', '80', '-rtbufsize', '64M',
  '-i', `audio=${ARGS.mic}`,
  '-f', 'f32le', '-ar', String(SR), '-ac', String(CH), '-',
];
const micFf = track(spawn(FFMPEG, micArgs, { stdio: ['ignore', 'pipe', 'ignore'] }), 'mic-ffmpeg');
const micMeter = makeMeter('MIC', null);
if (micFf && micFf.stdout) {
  micFf.stdout.on('error', () => {});
  micFf.stdout.on('data', (d) => micMeter.feed(d));
}

// TAP 3 MIX (unless --no-mix): ONE ffmpeg taking the mic (dshow, input 0) AND the
// internal audio (pipe:0 = wasaploop stdout tee, input 1), running the EXACT app
// filtergraph, outputting mixed f32le/48k/2ch on stdout for metering.
let mixMeter = null;
let mixFf = null;
if (ARGS.mix) {
  // mic-index 0, sys-index 1. Graph is the literal buildNativeAudio mic+system graph.
  const graph =
    '[0:a]aresample=async=1:min_hard_comp=0.100:first_pts=0,highpass=f=80:poles=2,' +
    'afftdn=nr=10:nf=-47:tn=1,' +
    'agate=threshold=0.0079:ratio=2:attack=10:release=300:range=0.0631:knee=6:detection=rms,' +
    'lowshelf=g=1.5:f=120:width_type=q:w=0.7,' +
    'equalizer=f=250:width_type=q:w=1.0:g=-2.5,' +
    'equalizer=f=3000:width_type=q:w=1.0:g=3,' +
    'highshelf=g=2:f=12000:width_type=q:w=0.7,' +
    'acompressor=threshold=0.0635:ratio=3.4:attack=5:release=150:knee=6:makeup=2.51,' +
    'volume=0dB,alimiter=limit=0.5:attack=5:release=50:level=disabled[m];' +
    '[1:a]aresample=async=1:first_pts=0,volume=0dB[s];' +
    '[m][s]amix=inputs=2:duration=longest:normalize=0[aout]';
  const mixArgs = [
    '-hide_banner', '-loglevel', 'error',
    // input 0: mic (dshow)
    '-f', 'dshow', '-audio_buffer_size', '80', '-rtbufsize', '64M',
    '-i', `audio=${ARGS.mic}`,
    // input 1: internal audio on stdin (f32le from wasaploop tee)
    '-f', 'f32le', '-ar', String(SR), '-ac', String(CH),
    '-i', 'pipe:0',
    '-filter_complex', graph,
    '-map', '[aout]',
    '-f', 'f32le', '-ar', String(SR), '-ac', String(CH), '-',
  ];
  mixFf = track(spawn(FFMPEG, mixArgs, { stdio: ['pipe', 'pipe', 'ignore'] }), 'mix-ffmpeg');
  mixMeter = makeMeter('MIX', null);
  if (mixFf) {
    if (mixFf.stdin) mixFf.stdin.on('error', () => {}); // dead pipe must not crash
    if (mixFf.stdout) {
      mixFf.stdout.on('error', () => {});
      mixFf.stdout.on('data', (d) => mixMeter.feed(d));
    }
    // TEE the single wasaploop stdout into the mix ffmpeg stdin.
    if (wasap && wasap.stdout) {
      wasap.stdout.on('data', (d) => {
        try { if (mixFf.stdin && mixFf.stdin.writable) mixFf.stdin.write(d); } catch {}
      });
      wasap.stdout.on('end', () => { try { mixFf.stdin && mixFf.stdin.end(); } catch {} });
      wasap.stdout.on('close', () => { try { mixFf.stdin && mixFf.stdin.end(); } catch {} });
    }
  }
}

// ---------------------------------------------------------------------------
// Time series + live printer (every ~500 ms)
// ---------------------------------------------------------------------------
const MIC_ON_DB = -45; // mic rms above this => mic considered ON
const series = [];     // { t, intRms, intPk, micRms, micPk, mixRms, mixPk, micOn }
const startMs = Date.now();
let shuttingDown = false;

function fmt(db) {
  if (!isFinite(db)) return '  -inf';
  return (db <= DB_FLOOR ? db : db).toFixed(1).padStart(6);
}

const printTimer = setInterval(() => {
  const t = (Date.now() - startMs) / 1000;
  const i = internalMeter.state;
  const m = micMeter.state;
  const x = mixMeter ? mixMeter.state : null;
  const micOn = m.rms > MIC_ON_DB;
  series.push({
    t,
    intRms: i.rms, intPk: i.peak,
    micRms: m.rms, micPk: m.peak,
    mixRms: x ? x.rms : null, mixPk: x ? x.peak : null,
    micOn,
  });
  let line = `t=${t.toFixed(1).padStart(5)}s  INTERNAL rms=${fmt(i.rms)} pk=${fmt(i.peak)}` +
    ` | MIC rms=${fmt(m.rms)} pk=${fmt(m.peak)} (${micOn ? 'ON ' : 'off'})`;
  if (x) line += ` | MIX rms=${fmt(x.rms)} pk=${fmt(x.peak)}`;
  process.stdout.write(line + '\n');
}, 500);

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
function mean(arr) {
  const v = arr.filter((n) => typeof n === 'number' && isFinite(n) && n > DB_FLOOR);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}
function fnum(x, suffix = '') { return x === null ? 'n/a' : (x.toFixed(2) + suffix); }

function printVerdict() {
  const off = series.filter((s) => !s.micOn);
  const on = series.filter((s) => s.micOn);

  const intOff = mean(off.map((s) => s.intRms));
  const intOn = mean(on.map((s) => s.intRms));
  const mixOff = mean(off.map((s) => s.mixRms));
  const mixOn = mean(on.map((s) => s.mixRms));

  const intDelta = (intOff !== null && intOn !== null) ? (intOn - intOff) : null; // negative = dropped
  const mixDelta = (mixOff !== null && mixOn !== null) ? (mixOn - mixOff) : null;

  console.log('\n============================== VERDICT ==============================');
  console.log(`samples: ${series.length}  (mic-OFF windows: ${off.length}, mic-ON windows: ${on.length})`);
  console.log(`mic ON threshold: rms > ${MIC_ON_DB} dBFS    duration: ${ARGS.secs}s    pid: ${ARGS.pid || 'ALL (endpoint loopback)'}`);
  console.log('--------------------------------------------------------------------');
  console.log(`INTERNAL rms   mic-OFF mean = ${fnum(intOff, ' dBFS')}   mic-ON mean = ${fnum(intOn, ' dBFS')}`);
  if (intDelta !== null) {
    const dir = intDelta < 0 ? 'DROP' : 'rise';
    console.log(`               delta (ON - OFF) = ${intDelta >= 0 ? '+' : ''}${intDelta.toFixed(2)} dB  (${dir} of ${Math.abs(intDelta).toFixed(2)} dB when mic is ON)`);
  } else {
    console.log('               delta = n/a (need both mic-ON and mic-OFF windows; play audio + toggle the mic)');
  }
  if (mixMeter) {
    console.log(`MIX rms        mic-OFF mean = ${fnum(mixOff, ' dBFS')}   mic-ON mean = ${fnum(mixOn, ' dBFS')}`);
    if (mixDelta !== null) {
      const dir = mixDelta < 0 ? 'DROP' : 'rise';
      console.log(`               delta (ON - OFF) = ${mixDelta >= 0 ? '+' : ''}${mixDelta.toFixed(2)} dB  (${dir} of ${Math.abs(mixDelta).toFixed(2)} dB)`);
    } else {
      console.log('               delta = n/a');
    }
  }
  console.log('--------------------------------------------------------------------');

  // Conclusion
  if (intDelta === null) {
    console.log('INCONCLUSIVE: did not observe BOTH mic-off and mic-on windows. Re-run while');
    console.log('Discord (or system audio) plays continuously and turn the mic on partway through.');
  } else if (intDelta < -1.0) {
    console.log(`INTERNAL audio is ducked AT THE SOURCE (wasaploop) by ${Math.abs(intDelta).toFixed(2)} dB when the mic is ON`);
    console.log('=> external cause: Windows communications ducking or Discord attenuation, NOT the');
    console.log('   app mix. Fix in OS/Discord settings.');
    console.log('   (Sound > Communications > "Do nothing"; Discord > Voice & Video > Attenuation = 0%.)');
  } else {
    console.log(`Internal source is FLAT (delta ${intDelta >= 0 ? '+' : ''}${intDelta.toFixed(2)} dB, within +/-1.0 dB) when the mic is ON.`);
    console.log('Ducking is NOT at capture (wasaploop sees Discord at full level regardless of mic).');
    if (mixMeter && mixDelta !== null && mixDelta < -1.0) {
      console.log(`HOWEVER the MIX drops ${Math.abs(mixDelta).toFixed(2)} dB when the mic is ON => the attenuation is in OUR`);
      console.log('   filtergraph (bus limiter/amix reacting to the mic). Fix in buildNativeAudio.');
    } else {
      console.log('If you still perceive Discord low: it is not the source and not the mix delta here —');
      console.log('   it is perception or absolute levels (raise sysGainDb / Discord output volume).');
    }
  }
  console.log('====================================================================');
}

// ---------------------------------------------------------------------------
// Clean shutdown
// ---------------------------------------------------------------------------
let exited = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(printTimer);
  clearTimeout(endTimer);
  try { if (mixFf && mixFf.stdin) mixFf.stdin.end(); } catch {}
  for (const { p } of children) {
    try { p.kill('SIGTERM'); } catch {}
  }
  // Hard kill stragglers, then verdict + exit.
  setTimeout(() => {
    for (const { p } of children) { try { p.kill('SIGKILL'); } catch {} }
    if (!exited) {
      exited = true;
      if (reason) console.log(`\n(stopping: ${reason})`);
      try { printVerdict(); } catch (e) { console.error('verdict error: ' + e.message); }
      process.exit(0);
    }
  }, 250);
}

const endTimer = setTimeout(() => shutdown('duration reached'), ARGS.secs * 1000);
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Banner
console.log(`audiometer: mic="${ARGS.mic}"  pid=${ARGS.pid || 'ALL'}  secs=${ARGS.secs}  mix=${ARGS.mix ? 'on' : 'off'}`);
console.log(`ffmpeg:    ${FFMPEG}`);
console.log(`wasaploop: ${WASAPLOOP}`);
console.log('Play system audio (Discord) and toggle the mic during the run. Ctrl+C to stop early.\n');
