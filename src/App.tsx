import React, { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Compositor, presetScenes } from './engine/compositor';
import { Mixer } from './engine/mixer';
import { PhoneSource } from './engine/phonesource';
import { Recorder, Streamer } from './engine/recorder';
import { MicSource, ScreenSource, WebcamSource } from './engine/sources';
import { DEFAULT_FX, presetBands, VoiceChain, type VoiceFx } from './engine/voicechain';
import { YouTubePanel } from './components/YouTubePanel';
import type { AudioApp, CamOverlay, CaptureSourceInfo, CaptureWindow, LinkInfo, Scene, SceneItem, Source } from './engine/types';

interface LibItem {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

type Picker = 'none' | 'screen' | 'webcam' | 'mic' | 'phone';

export function App() {
  const mixer = useMemo(() => new Mixer(), []);
  const compositor = useMemo(() => new Compositor(), []);
  const recorder = useMemo(() => new Recorder(), []);
  const previewRef = useRef<HTMLDivElement>(null);

  const [sources, setSources] = useState<Source[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [activeSceneId, setActiveSceneId] = useState<string>('');
  const [picker, setPicker] = useState<Picker>('none');
  const [captureList, setCaptureList] = useState<CaptureSourceInfo[]>([]);
  const [deviceList, setDeviceList] = useState<MediaDeviceInfo[]>([]);
  const [recState, setRecState] = useState<'inactive' | 'recording' | 'paused'>('inactive');
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState('Add a Screen or Camera source to begin');
  const [selection, setSelection] = useState<number>(-1); // index into active scene items
  const [, force] = useState(0);
  const [linkInfo, setLinkInfo] = useState<LinkInfo | null>(null);
  const [linkQr, setLinkQr] = useState<string>('');
  const [phoneConnected, setPhoneConnected] = useState(false);
  const [library, setLibrary] = useState<LibItem[]>([]);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [monitored, setMonitored] = useState<Record<string, boolean>>({});
  const chains = useRef(new Map<string, VoiceChain>()).current;
  const [fxMap, setFxMap] = useState<Record<string, VoiceFx>>({});
  const [fxOpen, setFxOpen] = useState<string | null>(null);
  const streamer = useMemo(() => new Streamer(), []);
  // Internal-audio source: '' = all system audio; otherwise a process NAME (PID is resolved
  // live at go-live, since PIDs change between runs). Keeps Discord clean & mic separate.
  // Internal audio: a SET of app names to capture (multi-select); [] = all system audio.
  const [internalAppNames, setInternalAppNames] = useState<string[]>(
    JSON.parse(localStorage.getItem('internalApps') ?? '[]'),
  );
  const [audioApps, setAudioApps] = useState<AudioApp[]>([]);
  const refreshAudioApps = () => window.screencap.listAudioApps().then(setAudioApps);
  useEffect(() => { void refreshAudioApps(); }, []);
  // "Share one window" mode: pick a single window → wgccap captures only it (video) and only its
  // app's audio (wasaploop of its PID). Scopes BOTH, fixing the "shared Discord but recorded
  // other apps + Firefox audio" bug. null = full-screen/scene mode.
  const [windowList, setWindowList] = useState<CaptureWindow[]>([]);
  const [shareWindow, setShareWindow] = useState<CaptureWindow | null>(null);
  const refreshWindows = () => window.screencap.listWindows().then(setWindowList);
  // 🎥 Facecam (webcam) PiP overlay — composited natively into the stream/recording.
  const [camList, setCamList] = useState<string[]>([]);
  const [cam, setCamState] = useState<CamOverlay | null>(JSON.parse(localStorage.getItem('cam') ?? 'null'));
  const refreshCameras = () => window.screencap.listCameras().then(setCamList);
  const setCam = (c: CamOverlay | null) => { setCamState(c); localStorage.setItem('cam', JSON.stringify(c)); };
  const patchCam = (p: Partial<CamOverlay>) =>
    setCam({ device: '', pos: 'br', sizePct: 0.25, mirror: false, ...(cam ?? {}), ...p });
  function toggleInternalApp(name: string) {
    setInternalAppNames((cur) => {
      const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
      localStorage.setItem('internalApps', JSON.stringify(next));
      return next;
    });
  }
  // Independent operator-controlled levels for the native mix (Discord never auto-ducks).
  const [sysGainDb, setSysGainDb] = useState(Number(localStorage.getItem('sysGainDb') ?? '0'));
  const [micGainDb, setMicGainDb] = useState(Number(localStorage.getItem('micGainDb') ?? '0'));
  // A/V sync: WASAPI loopback delivers already-played audio, so system sound trails the live
  // picture. Negative = advance system audio (fixes the lag). Default -60ms: MEASURED through the
  // real ddagrab+wasaploop pipeline (flash-vs-beep capture of a Firefox sync test = ~58ms lag).
  const [sysDelayMs, setSysDelayMs] = useState(Number(localStorage.getItem('sysDelayMs') ?? '-60'));
  // Per-app volume + mute (keyed by app/process name) — operator rides or mutes each app's sound
  // (e.g. duck Discord while speaking); viewers hear exactly the controlled level. -120 = muted.
  const [appGains, setAppGains] = useState<Record<string, number>>(JSON.parse(localStorage.getItem('appGains') ?? '{}'));
  const [appMuted, setAppMuted] = useState<Record<string, boolean>>(JSON.parse(localStorage.getItem('appMuted') ?? '{}'));
  const setAppGain = (name: string, db: number) =>
    setAppGains((g) => { const n = { ...g, [name]: db }; localStorage.setItem('appGains', JSON.stringify(n)); return n; });
  const toggleAppMute = (name: string) =>
    setAppMuted((m) => { const n = { ...m, [name]: !m[name] }; localStorage.setItem('appMuted', JSON.stringify(n)); return n; });
  const appGainDb = (name: string) => (appMuted[name] ? -120 : (appGains[name] ?? 0));
  // Push per-app volume/mute to the running stream + recording mixers LIVE (order matches the
  // capture: the picked apps, or the single shared window). No-op in the backend if idle.
  useEffect(() => {
    const gainApps = shareWindow ? [shareWindow.name] : internalAppNames;
    window.screencap.setSysGains(gainApps.map((n) => (appMuted[n] ? -120 : (appGains[n] ?? 0))));
  }, [appGains, appMuted, internalAppNames, shareWindow]);
  const [streamUrl, setStreamUrl] = useState(localStorage.getItem('streamUrl') ?? 'rtmp://a.rtmp.youtube.com/live2');
  // Native capture is the ONLY streaming engine now — ffmpeg captures screen + mic + system
  // audio directly (no Chromium in the media path). The old MediaRecorder pipe path and its
  // footgun toggle are gone; this constant stays true so the native branches always run.
  const directMode = true;
  localStorage.removeItem('directMode'); // clear any persisted "off" from the old toggle
  const [streamKey, setStreamKey] = useState(localStorage.getItem('streamKey') ?? '');
  const [live, setLive] = useState(false);
  const [audioAlert, setAudioAlert] = useState<string | null>(null);
  // True only when the WebAudio mixer is actually feeding a live consumer (legacy
  // recording / scene streaming). In native mode (ffmpeg captures the mic itself) the
  // mixer isn't in the path, so a starvation warning there is a false alarm.
  const streamIsNative = useRef(false);

  useEffect(() => {
    void mixer.startWatchdog(setAudioAlert);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.screencap.onLinkStatus((s) => setPhoneConnected(s.phone === 'connected'));
    window.screencap.onNativeRecordFailed(() => {
      // Native recorder died on arrival (QSV/dshow init) — fall back transparently.
      nativeRecStart.current = null;
      setStatus('native recorder unavailable — using studio recorder');
      legacyRecord();
    });
    window.screencap.onStreamEnded((code, reason) => {
      setLive(false);
      streamer.stop();
      // Release the powerSaveBlocker on autonomous deaths too (review finding: a network
      // drop or restart-budget exhaustion otherwise left it engaged until app quit).
      window.screencap.sessionActive(recorder.state !== 'inactive');
      setStatus(
        code === 0
          ? 'stream ended'
          : `stream ended — ${reason || `ffmpeg exit ${code}`}`,
      );
    });
    window.screencap.onStreamHealth((h) => {
      setStatus(
        `🔴 LIVE · ${h.kbps} kbps · ${h.fps.toFixed(0)} fps · speed ${h.speed.toFixed(2)}x` +
          (h.attempts > 0 ? ` · ${h.attempts} restarts` : ''),
      );
    });
    window.screencap.onStreamRestarting((n, reason, delay) => {
      setStatus(`⚠ stream restarting (#${n} in ${delay / 1000}s) — ${reason}`);
    });
    window.screencap.onStreamResume(() => streamer.restartCapture());
    void refreshLibrary();
  }, []);

  async function refreshLibrary() {
    setLibrary(await window.screencap.libraryList());
  }

  // Mount the compositor canvas into the preview.
  useEffect(() => {
    previewRef.current?.appendChild(compositor.canvas);
  }, [compositor]);

  // Timer + meters tick.
  useEffect(() => {
    const iv = setInterval(() => {
      setElapsed(nativeRecStart.current !== null ? Date.now() - nativeRecStart.current : recorder.elapsedMs);
      force((x) => x + 1); // meters redraw
    }, 200);
    return () => clearInterval(iv);
  }, [recorder]);

  // Diagnostic: log the phone strip's post-gain peak every 2s (visible in the console log).
  useEffect(() => {
    const iv = setInterval(() => {
      for (const s of sources) {
        if (s.kind === 'phone-cam') {
          console.log(`[Mixer] phone strip peak = ${mixer.peak(s.id).toFixed(3)}`);
        }
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [sources, mixer]);

  function testTone() {
    // Straight to the speakers — validates the output device + context independent of sources.
    const osc = mixer.ctx.createOscillator();
    const g = mixer.ctx.createGain();
    g.gain.value = 0.2;
    osc.frequency.value = 440;
    osc.connect(g);
    g.connect(mixer.ctx.destination);
    osc.start();
    osc.stop(mixer.ctx.currentTime + 0.5);
    setStatus('test tone played (440Hz, 0.5s)');
  }

  // Hotkeys F1..F8 for scenes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Match by the scene's DECLARED hotkey (labels and behavior must agree).
      const sc = scenes.find((s) => s.hotkey === e.key);
      if (sc) {
        e.preventDefault();
        switchScene(sc.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function refreshScenes(srcs: Source[], keepActive = true) {
    const screen = srcs.find((s) => s.kind === 'screen' && s.video);
    const cam = srcs.find((s) => (s.kind === 'webcam' || s.kind === 'phone-cam') && s.video);
    const presets = presetScenes(screen?.id ?? null, cam?.id ?? null);
    setScenes(presets);
    if (!keepActive || !presets.find((s) => s.id === activeSceneId)) {
      if (presets.length) {
        setActiveSceneId(presets[0].id);
        compositor.setScene(presets[0], false);
      }
    }
  }

  function switchScene(id: string) {
    const sc = scenes.find((s) => s.id === id);
    if (sc) {
      setActiveSceneId(id);
      compositor.setScene(sc);
      setSelection(-1);
    }
  }

  async function addSource(make: () => Source) {
    try {
      const s = make();
      await s.start();
      compositor.registerSource(s);
      if (s.audioNode) {
        if (s.kind === 'mic' || s.kind === 'phone-cam') {
          // Voice strips run the studio chain (HPF→RNNoise→gate→EQ→comp) pre-mixer,
          // so the strip's meter and gain see the PROCESSED signal.
          const saved = localStorage.getItem(`voicefx:${s.label}`);
          const parsed = saved ? JSON.parse(saved) : null;
          let initial: VoiceFx | undefined = parsed ? { ...DEFAULT_FX, ...parsed } : undefined;
          if (initial && parsed.eqLow === undefined && parsed.preset) {
            // v1 settings stored only the preset name — expand it into the band fields.
            const [lo, mud, pres, air] = presetBands(parsed.preset);
            initial = { ...initial, eqLow: lo, eqMud: mud, eqPresence: pres, eqAir: air };
          }
          if (initial && parsed.fxVersion !== 2) {
            // v2 migration (panel retune): drop dead keys (deepDenoise) and reset the
            // stage params the expander/comp redesign was tuned around; user EQ/denoise
            // preferences survive. echoCancel forced safe (AEC chops live speech).
            delete (initial as unknown as Record<string, unknown>).deepDenoise;
            initial = {
              ...initial,
              echoCancel: false,
              gateDb: DEFAULT_FX.gateDb,
              compAmount: DEFAULT_FX.compAmount,
              makeupDb: DEFAULT_FX.makeupDb,
            };
            localStorage.setItem(`voicefx:${s.label}`, JSON.stringify({ ...initial, fxVersion: 2 }));
          }
          const chain = new VoiceChain(mixer.ctx, initial);
          await chain.init();
          s.audioNode.connect(chain.input);
          mixer.attach(s.id, chain.output);
          chains.set(s.id, chain);
          setFxMap((m) => ({ ...m, [s.id]: chain.settings }));
          // Capture starts AEC-free (adaptive AEC chops live speech); a deliberate
          // persisted ON gets a re-acquire with it enabled.
          if (s instanceof MicSource && chain.settings.echoCancel) {
            void s.setEchoCancellation(true).then((node) => node?.connect(chain.input));
          }
        } else {
          mixer.attach(s.id, s.audioNode);
        }
        if (s.kind === 'phone-cam') {
          // Remote source: hearing it live is expected (no feedback risk from a far mic).
          mixer.setMonitor(s.id, true);
          setMonitored((m) => ({ ...m, [s.id]: true }));
        }
      }
      const next = [...sources, s];
      setSources(next);
      refreshScenes(next);
      setStatus('');
    } catch (e) {
      setStatus((e as Error).message);
    }
    setPicker('none');
  }

  async function openPicker(kind: Picker) {
    setPicker(kind);
    if (kind === 'phone') {
      const info = await window.screencap.linkStart();
      setLinkInfo(info);
      const payload = JSON.stringify({ host: info.ips[0], port: info.port, code: info.code });
      setLinkQr(await QRCode.toDataURL(payload, { margin: 1, width: 240 }));
    } else if (kind === 'screen') {
      setCaptureList(await window.screencap.getCaptureSources());
    } else if (kind === 'webcam' || kind === 'mic') {
      try {
        (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
      } catch {}
      const devs = await navigator.mediaDevices.enumerateDevices();
      setDeviceList(devs.filter((d) => d.kind === (kind === 'webcam' ? 'videoinput' : 'audioinput')));
    }
  }

  function removeSource(id: string) {
    const s = sources.find((x) => x.id === id);
    if (!s) return;
    s.stop();
    mixer.detach(id);
    chains.get(id)?.dispose();
    chains.delete(id);
    if (fxOpen === id) setFxOpen(null);
    compositor.unregisterSource(id);
    const next = sources.filter((x) => x.id !== id);
    setSources(next);
    refreshScenes(next, false);
  }

  function updateFx(id: string, patch: Partial<VoiceFx>) {
    const chain = chains.get(id);
    if (!chain) return;
    const next = { ...chain.settings, ...patch };
    chain.apply(next);
    const src = sources.find((s) => s.id === id);
    if (patch.echoCancel !== undefined && src instanceof MicSource) {
      // Re-acquire swaps the source node — reconnect the fresh one into the chain.
      // While monitoring, AEC stays suspended regardless (it chops self-monitored voice).
      void src.setEchoCancellation(patch.echoCancel && !monitored[id]).then((node) => {
        const ch = chains.get(id);
        if (node && ch) node.connect(ch.input);
      });
    }
    setFxMap((m) => ({ ...m, [id]: next }));
    if (src) localStorage.setItem(`voicefx:${src.label}`, JSON.stringify({ ...next, fxVersion: 2 }));
  }

  const nativeRecStart = useRef<number | null>(null);

  function legacyRecord() {
    recorder.start(compositor.captureStream(30), mixer.stream, (saved) => {
      setStatus(saved ? `saved → ${saved}` : 'save failed');
      void refreshLibrary();
    });
    setRecState('recording');
    window.screencap.sessionActive(true);
  }

  async function toggleRecord() {
    if (nativeRecStart.current !== null) {
      // Stop native recording: clean ffmpeg shutdown + remux.
      nativeRecStart.current = null;
      setRecState('inactive');
      compositor.setPreviewFps(live ? 10 : 30);
      const saved = await window.screencap.nativeRecordStop();
      window.screencap.sessionActive(live);
      setStatus(saved ? `saved → ${saved}` : 'save failed');
      void refreshLibrary();
      return;
    }
    if (recorder.state !== 'inactive') {
      recorder.stop();
      setRecState('inactive');
      window.screencap.sessionActive(live);
      return;
    }
    // Native-first (throttle-proof): direct mode → ffmpeg records screen + mic + system
    // audio (all native) itself. Scene mode keeps the compositor/MediaRecorder path.
    const nat = await nativeAudioPlan();
    if (directMode && (nat.micDevice || nat.audio.system || nat.audio.windowHwnd || nat.audio.cam)) {
      const res = await window.screencap.nativeRecordStart(nat.micDevice, nat.fx, nat.audio);
      if (res.ok) {
        nativeRecStart.current = Date.now();
        setRecState('recording');
        setStatus(nat.audio.windowHwnd
          ? `● recording window: ${shareWindow?.title?.slice(0, 30)} (video + that app's audio + mic)`
          : '● recording (fully native: screen + mic + system audio)');
        compositor.setPreviewFps(10); // free the iGPU for ddagrab+QSV
        window.screencap.sessionActive(true);
        return;
      }
    }
    legacyRecord();
  }

  /** What the native ffmpeg pipeline should capture, from the current studio sources. */
  async function nativeAudioPlan() {
    const mic = directMode ? sources.find((s) => s.kind === 'mic') : undefined;
    const micDevice = mic?.label ?? null;
    // System audio (Discord, music, game) is captured NATIVELY (WASAPI loopback / wasaploop)
    // in direct mode — NOT via a WebAudio audioNode. So capture it whenever the user is sharing
    // a screen OR has picked internal apps, and NEVER gate it off just because a mic is also
    // present. (The old `screen && audioNode` test + a mic-less-only fallback meant that the
    // instant a mic was added, Discord/system audio silently vanished from the capture — the
    // only "Discord" left was the mic picking up headphone earcup bleed.)
    const system = directMode && (
      internalAppNames.length > 0 ||                 // explicitly picked apps (e.g. Discord)
      sources.some((s) => s.kind === 'screen') ||    // sharing a screen → want its audio
      !micDevice                                     // mic-less direct stream isn't silent
    );
    // Per-app internal audio: resolve the chosen process names → their CURRENT pids so only
    // those apps' sound is captured, kept separate from the mic. [] = all system audio.
    // systemGains is PARALLEL to systemPids — each app's operator-set volume (or mute).
    const systemPids: number[] = [];
    const systemGains: number[] = [];
    if (system && internalAppNames.length) {
      const apps = await window.screencap.listAudioApps();
      for (const n of internalAppNames) {
        const pid = apps.find((a) => a.name === n)?.pid;
        if (typeof pid === 'number' && pid > 0) { systemPids.push(pid); systemGains.push(appGainDb(n)); }
      }
    }
    const fx = micDevice && mic ? chains.get(mic.id)?.settings ?? null : null;
    // Window-capture mode: bind video + audio to the one chosen window (its app's volume too).
    const win = shareWindow;
    // In per-app / window mode the per-app gains ARE the control, so the ffmpeg master system
    // trim is unity (else it would multiply on top). Master only applies in all-system mode.
    const masterSys = (win || internalAppNames.length) ? 0 : sysGainDb;
    return {
      micDevice, fx,
      audio: {
        system, systemPids, systemGains, sysGainDb: masterSys, micGainDb,
        windowHwnd: win?.hwnd, windowPid: win?.pid,
        windowGainDb: win ? appGainDb(win.name) : 0,
        cam: cam && cam.device ? cam : null,
        sysDelayMs,
      },
    };
  }

  function stopStream() {
    streamer.stop();
    setLive(false);
    setStatus('stream stopped');
    compositor.setPreviewFps(nativeRecStart.current !== null ? 10 : 30);
    window.screencap.sessionActive(recorder.state !== 'inactive');
  }

  /** Start the native pipeline to an explicit ingest URL + key. Returns an error or null. */
  async function startStream(url: string, key: string): Promise<string | null> {
    if (!key) return 'no stream key';
    setStatus('starting stream…');
    // FULLY NATIVE audio: ffmpeg captures the mic (DirectShow) AND system audio (native
    // WASAPI loopback, wasaploop.exe) and mixes them in-filter. No Chromium in the live
    // path → immune to renderer/occlusion throttling (the switch-away breaking).
    const nat = await nativeAudioPlan();
    streamIsNative.current = directMode && (!!nat.micDevice || nat.audio.system || !!nat.audio.windowHwnd || !!nat.audio.cam);
    const err = await streamer.start(
      compositor.captureStream(30), mixer.stream, url, key, 6000, directMode,
      nat.micDevice, nat.fx, nat.audio,
    );
    if (err) {
      setStatus(`stream failed: ${err}`);
      return err;
    }
    setLive(true);
    setStatus(
      streamIsNative.current
        ? `🔴 connecting… (FULLY NATIVE: screen${nat.micDevice ? ' + mic' : ''}${nat.audio.system ? ' + system audio' : ''})`
        : '🔴 connecting…',
    );
    // Native stream captures the screen itself — throttle the preview canvas so it stops
    // competing with ddagrab+QSV for the iGPU (the cause of the <1.0x audio drops).
    if (streamIsNative.current) compositor.setPreviewFps(10);
    window.screencap.sessionActive(true);
    return null;
  }

  async function goLive(url: string, key: string) {
    if (live) return stopStream();
    if (!key) {
      setStatus('enter your stream key first');
      return;
    }
    await startStream(url, key);
  }

  const toggleLive = () => goLive(streamUrl, streamKey);
  const testLocal = () => goLive('rtmp://127.0.0.1:19350/live', 'test');

  async function screenshot() {
    const saved = await window.screencap.saveScreenshot(compositor.screenshot());
    setStatus(saved ? `screenshot → ${saved}` : 'canceled');
  }

  // ----- scene item drag / resize on the preview -----
  const dragRef = useRef<{ idx: number; mode: 'move' | 'resize'; sx: number; sy: number; orig: SceneItem } | null>(null);

  function previewPos(e: React.PointerEvent): { x: number; y: number } {
    const r = compositor.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }

  function onPreviewDown(e: React.PointerEvent) {
    const sc = compositor.activeScene;
    if (!sc) return;
    const p = previewPos(e);
    const items = [...sc.items].sort((a, b) => b.z - a.z);
    const hit = items.find((it) => p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h);
    if (!hit) {
      setSelection(-1);
      return;
    }
    const idx = sc.items.indexOf(hit);
    setSelection(idx);
    dragRef.current = { idx, mode: 'move', sx: p.x, sy: p.y, orig: { ...hit } };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onGripDown(e: React.PointerEvent) {
    const sc = compositor.activeScene;
    if (!sc || selection < 0) return;
    e.stopPropagation();
    const p = previewPos(e);
    dragRef.current = { idx: selection, mode: 'resize', sx: p.x, sy: p.y, orig: { ...sc.items[selection] } };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPreviewMove(e: React.PointerEvent) {
    const d = dragRef.current;
    const sc = compositor.activeScene;
    if (!d || !sc) return;
    const p = previewPos(e);
    const dx = p.x - d.sx;
    const dy = p.y - d.sy;
    const it = sc.items[d.idx];
    if (d.mode === 'move') {
      it.x = Math.min(Math.max(d.orig.x + dx, -d.orig.w + 0.02), 0.98);
      it.y = Math.min(Math.max(d.orig.y + dy, -d.orig.h + 0.02), 0.98);
    } else {
      it.w = Math.min(Math.max(d.orig.w + dx, 0.06), 1.5);
      it.h = Math.min(Math.max(d.orig.h + dy, 0.06), 1.5);
    }
    force((x) => x + 1);
  }

  function onPreviewUp() {
    dragRef.current = null;
  }

  const activeScene = scenes.find((s) => s.id === activeSceneId);
  const selItem = activeScene && selection >= 0 ? activeScene.items[selection] : null;

  function fmt(ms: number) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  return (
    <div className="studio">
      <div className="topbar">
        <h1>ScreenCap <b>●</b> Studio</h1>
        <span className="status">{status}</span>
      </div>

      <div className="main">
        <div className="col">
          <h2>Sources</h2>
          <button className="add" onClick={() => openPicker('screen')}>＋ Screen / Window</button>
          <button className="add" onClick={() => openPicker('webcam')}>＋ Camera</button>
          <button className="add" onClick={() => openPicker('mic')}>＋ Microphone</button>
          <button className="add" onClick={() => openPicker('phone')}>＋ Phone (Link)</button>
          {sources.map((s) => (
            <div className="card" key={s.id} onContextMenu={() => removeSource(s.id)}>
              {s.label}
              <small>{s.kind} · right-click to remove</small>
              {s.kind === 'phone-cam' && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    className="add" style={{ marginBottom: 0 }}
                    onClick={(e) => { e.stopPropagation(); s.rotation = (s.rotation + 90) % 360; force((x) => x + 1); }}
                  >↻ {s.rotation}°</button>
                  <button
                    className="add" style={{ marginBottom: 0 }}
                    onClick={(e) => { e.stopPropagation(); (s as PhoneSource).sendControl({ cmd: 'switch-camera' }); }}
                  >🔄 lens</button>
                </div>
              )}
            </div>
          ))}

          {/* 🪟 Share-window + 🔊 internal-audio picker + per-app/mic faders live in the
              full-width audio mixer at the bottom of the window. */}

          <div style={{ marginTop: 14 }}>
            <YouTubePanel live={live} startStream={startStream} stopStream={stopStream} />
          </div>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--dim)' }}>Custom RTMP (advanced)</summary>
            <input
              className="add" style={{ textAlign: 'left', marginTop: 8 }} placeholder="RTMP URL"
              value={streamUrl}
              onChange={(e) => { setStreamUrl(e.target.value); localStorage.setItem('streamUrl', e.target.value); }}
            />
            <input
              className="add" style={{ textAlign: 'left' }} placeholder="Stream key" type="password"
              value={streamKey}
              onChange={(e) => { setStreamKey(e.target.value); localStorage.setItem('streamKey', e.target.value); }}
            />
            <div style={{ fontSize: 11, color: 'var(--dim)', margin: '4px 0 8px' }}>
              🖥️ Native capture (ffmpeg: screen + mic + system audio) — always on.
            </div>
            <button className="add" onClick={() => goLive(streamUrl, streamKey)}>
              {live ? '⏹ End stream' : '🔴 Go Live (custom)'}
            </button>
            <button className="add" onClick={testLocal}>🧪 Test stream (local harness)</button>
          </details>
        </div>

        {audioAlert &&
          // Only meaningful when the WebAudio mixer actually feeds a live consumer:
          // legacy recording (not native) or a scene/pipe stream (not native).
          ((recState !== 'inactive' && nativeRecStart.current === null) ||
            (live && !streamIsNative.current)) && (
          <div
            style={{
              position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 100,
              background: '#7f1d1d', color: '#fff', border: '1px solid #ef4444', borderRadius: 8,
              padding: '8px 16px', fontSize: 13, fontWeight: 600, boxShadow: '0 4px 20px rgba(0,0,0,.5)',
            }}
          >
            {audioAlert}
          </div>
        )}
        <div className="preview-wrap">
          <div
            className="preview"
            ref={previewRef}
            onPointerDown={onPreviewDown}
            onPointerMove={onPreviewMove}
            onPointerUp={onPreviewUp}
          >
            {selItem && (
              <div className="handles">
                <div
                  className="sel"
                  style={{
                    left: `${selItem.x * 100}%`,
                    top: `${selItem.y * 100}%`,
                    width: `${selItem.w * 100}%`,
                    height: `${selItem.h * 100}%`,
                  }}
                >
                  <div className="grip" onPointerDown={onGripDown} />
                </div>
              </div>
            )}
            {cam?.device && (
              <div
                style={{
                  position: 'absolute',
                  width: `${(cam.sizePct ?? 0.25) * 100}%`,
                  aspectRatio: '16 / 9',
                  border: '2px dashed var(--accent2)',
                  background: 'rgba(108,99,255,0.14)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, color: 'var(--accent2)', pointerEvents: 'none', borderRadius: 4,
                  ...((cam.pos ?? 'br').includes('t') ? { top: '2.6%' } : { bottom: '2.6%' }),
                  ...((cam.pos ?? 'br').includes('l') ? { left: '1.5%' } : { right: '1.5%' }),
                }}
              >📷 facecam</div>
            )}
          </div>
          <div className="controls">
            <button className={`btn rec ${recState !== 'inactive' ? 'on' : ''}`} onClick={toggleRecord}>
              {recState === 'inactive' ? '● Record' : '■ Stop'}
            </button>
            <button
              className="btn sec"
              disabled={recState === 'inactive'}
              onClick={() => {
                recorder.togglePause();
                setRecState(recorder.state as 'recording' | 'paused');
              }}
            >
              {recState === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button className="btn sec" onClick={screenshot}>📸</button>
            <button className="btn sec" onClick={testTone}>♪</button>
            <button
              className="btn"
              style={{ background: live ? '#5c6270' : '#b71c1c', color: '#fff' }}
              onClick={toggleLive}
            >
              {live ? '⏹ End stream' : '🔴 Go LIVE'}
            </button>
            <span className={`timer ${recState !== 'inactive' || live ? 'live' : ''}`}>{fmt(elapsed)}</span>
          </div>
        </div>

        <div className="col">
          <h2>Scenes</h2>
          {scenes.map((sc) => (
            <div
              key={sc.id}
              className={`card ${sc.id === activeSceneId ? 'active' : ''}`}
              onClick={() => switchScene(sc.id)}
            >
              {sc.name}
              {sc.hotkey && <span className="key">{sc.hotkey}</span>}
              <small>{sc.items.length} source(s) · drag/resize in preview</small>
            </div>
          ))}
          {scenes.length === 0 && <small style={{ color: 'var(--dim)' }}>Scenes appear when sources exist.</small>}

          <h2 style={{ marginTop: 14 }}>
            Library{' '}
            <a style={{ cursor: 'pointer', color: 'var(--accent2)' }} onClick={() => void window.screencap.libraryOpenFolder()}>
              open folder
            </a>
          </h2>
          {library.map((f) => (
            <div className="card" key={f.path}>
              <span style={{ fontSize: 12 }}>{f.name}</span>
              <small>{(f.size / 1048576).toFixed(1)} MB</small>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button className="add" style={{ marginBottom: 0 }} onClick={() => void window.screencap.libraryOpen(f.path)}>▶ Play</button>
                <button
                  className="add" style={{ marginBottom: 0 }}
                  onClick={async () => { await window.screencap.libraryDelete(f.path); void refreshLibrary(); }}
                >🗑</button>
              </div>
            </div>
          ))}
          {library.length === 0 && <small style={{ color: 'var(--dim)' }}>Recordings land here.</small>}
        </div>
      </div>

      <div className="mixer">
        {/* ===== Audio: capture selection + per-app / mic levels (full-width mixer) ===== */}
        <div className="strip" style={{ width: 236 }}>
          <div className="name">🎛️ Capture</div>
          <select className="add" style={{ width: '100%', marginBottom: 6, fontSize: 11, padding: 4 }}
            value={shareWindow ? String(shareWindow.hwnd) : ''} onMouseDown={refreshWindows}
            onChange={(e) => setShareWindow(windowList.find((x) => String(x.hwnd) === e.target.value) ?? null)}>
            <option value="">🖥️ Full screen / scene</option>
            {windowList.map((w) => (
              <option key={w.hwnd} value={String(w.hwnd)}>🪟 {w.name} — {w.title.slice(0, 24)}</option>
            ))}
          </select>
          {shareWindow ? (
            <div style={{ fontSize: 11, color: 'var(--dim)' }}>Sharing only “{shareWindow.title.slice(0, 22)}” — its window video + its own audio + your mic.</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dim)', marginBottom: 2 }}>
                <span>Internal audio apps</span>
                <a style={{ cursor: 'pointer' }} onClick={refreshAudioApps}>🔄</a>
              </div>
              <div style={{ maxHeight: 58, overflowY: 'auto', border: '1px solid #2a2a35', borderRadius: 6, padding: 4, fontSize: 11 }}>
                <label style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer', padding: '1px 0' }}>
                  <input type="checkbox" checked={internalAppNames.length === 0}
                    onChange={() => { setInternalAppNames([]); localStorage.setItem('internalApps', '[]'); }} /><b>All system</b>
                </label>
                {audioApps.map((a) => (
                  <label key={a.name} style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer', padding: '1px 0' }}>
                    <input type="checkbox" checked={internalAppNames.includes(a.name)} onChange={() => toggleInternalApp(a.name)} />
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={a.title}>{a.name}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        {(() => {
          const gainApps = shareWindow ? [shareWindow.name] : internalAppNames;
          if (gainApps.length === 0) {
            return (
              <div className="strip">
                <div className="name">🔊 System audio</div>
                <input type="range" min="-30" max="12" step="1" value={sysGainDb}
                  onChange={(e) => { const v = Number(e.target.value); setSysGainDb(v); localStorage.setItem('sysGainDb', String(v)); }} />
                <div style={{ fontSize: 11, color: 'var(--dim)', textAlign: 'right' }}>{sysGainDb > 0 ? '+' : ''}{sysGainDb} dB</div>
              </div>
            );
          }
          return gainApps.map((name) => (
            <div className="strip" key={'gain-' + name}>
              <div className="name" title={name}>{name}
                <a style={{ cursor: 'pointer', color: appMuted[name] ? 'var(--accent)' : 'var(--dim)', float: 'right' }}
                  title={appMuted[name] ? 'unmute' : 'mute'} onClick={() => toggleAppMute(name)}>{appMuted[name] ? '🔇' : '🔊'}</a>
              </div>
              <input type="range" min="-40" max="12" step="1" disabled={appMuted[name]}
                value={appGains[name] ?? 0} onChange={(e) => setAppGain(name, Number(e.target.value))} />
              <div style={{ fontSize: 11, color: appMuted[name] ? '#e66' : 'var(--dim)', textAlign: 'right' }}>
                {appMuted[name] ? 'muted' : `${(appGains[name] ?? 0) > 0 ? '+' : ''}${appGains[name] ?? 0} dB`}
              </div>
            </div>
          ));
        })()}
        <div className="strip">
          <div className="name">🎙 Mic level</div>
          <input type="range" min="-30" max="12" step="1" value={micGainDb}
            onChange={(e) => { const v = Number(e.target.value); setMicGainDb(v); localStorage.setItem('micGainDb', String(v)); }} />
          <div style={{ fontSize: 11, color: 'var(--dim)', textAlign: 'right' }}>{micGainDb > 0 ? '+' : ''}{micGainDb} dB</div>
        </div>
        <div className="strip" style={{ width: 188 }}>
          <div className="name">🎥 Facecam</div>
          <select className="add" style={{ width: '100%', marginBottom: 6, fontSize: 11, padding: 4 }}
            value={cam?.device ?? ''} onMouseDown={refreshCameras}
            onChange={(e) => setCam(e.target.value ? { device: e.target.value, pos: cam?.pos ?? 'br', sizePct: cam?.sizePct ?? 0.25, mirror: cam?.mirror ?? false } : null)}>
            <option value="">Off</option>
            {camList.map((c) => <option key={c} value={c}>{c.length > 22 ? c.slice(0, 22) + '…' : c}</option>)}
          </select>
          {cam?.device && (
            <>
              <div style={{ display: 'flex', gap: 3, marginBottom: 5 }}>
                {(['tl', 'tr', 'bl', 'br'] as const).map((p) => (
                  <button key={p} className="add" title={p}
                    style={{ marginBottom: 0, padding: '2px 0', flex: 1, fontSize: 13, outline: cam.pos === p ? '2px solid var(--accent2)' : 'none' }}
                    onClick={() => patchCam({ pos: p })}>{{ tl: '◰', tr: '◳', bl: '◱', br: '◲' }[p]}</button>
                ))}
              </div>
              <input type="range" min="12" max="45" step="1" value={Math.round((cam.sizePct ?? 0.25) * 100)}
                onChange={(e) => patchCam({ sizePct: Number(e.target.value) / 100 })} style={{ width: '100%' }} />
              <div style={{ fontSize: 11, color: 'var(--dim)', display: 'flex', justifyContent: 'space-between' }}>
                <span>size {Math.round((cam.sizePct ?? 0.25) * 100)}%</span>
                <a style={{ cursor: 'pointer', color: cam.mirror ? 'var(--accent2)' : 'var(--dim)' }} onClick={() => patchCam({ mirror: !cam.mirror })}>{cam.mirror ? '🔁 mirrored' : 'mirror'}</a>
              </div>
            </>
          )}
        </div>
        <div className="strip" style={{ width: 176 }}>
          <div className="name">⏱ A/V sync</div>
          <input type="range" min="-400" max="400" step="10" value={sysDelayMs}
            onChange={(e) => { const v = Number(e.target.value); setSysDelayMs(v); localStorage.setItem('sysDelayMs', String(v)); }} />
          <div style={{ fontSize: 11, color: 'var(--dim)', textAlign: 'right' }}>
            {sysDelayMs === 0 ? 'in sync' : sysDelayMs < 0 ? `audio ${-sysDelayMs}ms earlier` : `audio ${sysDelayMs}ms later`}
          </div>
          <div style={{ fontSize: 10, color: 'var(--dim)' }}>← drag left if audio lags the video</div>
        </div>
        {sources.filter((s) => s.audioNode).map((s) => (
          <div className="strip" key={s.id}>
            <div className="name">
              {s.label}{' '}
              <a
                style={{ cursor: 'pointer', color: muted[s.id] ? 'var(--accent)' : 'var(--dim)', float: 'right' }}
                onClick={() => {
                  const m = !muted[s.id];
                  setMuted({ ...muted, [s.id]: m });
                  mixer.setGain(s.id, m ? 0 : 1);
                }}
              >
                {muted[s.id] ? '🔇' : '🔊'}
              </a>
              <a
                title="Monitor on PC speakers"
                style={{ cursor: 'pointer', color: monitored[s.id] ? 'var(--accent2)' : 'var(--dim)', float: 'right', marginRight: 6 }}
                onClick={() => {
                  const m = !monitored[s.id];
                  setMonitored({ ...monitored, [s.id]: m });
                  mixer.setMonitor(s.id, m);
                  // AEC treats self-monitoring as far-end echo and chops the live voice
                  // (clicks/pauses) — suspend it while this mic is monitored, restore after.
                  if (s instanceof MicSource && chains.get(s.id) && fxMap[s.id]?.echoCancel) {
                    void s.setEchoCancellation(!m).then((node) => {
                      const ch = chains.get(s.id);
                      if (node && ch) node.connect(ch.input);
                    });
                    setStatus(m ? '🎧 monitoring — echo cancel suspended for this mic' : 'echo cancel restored');
                  }
                }}
              >
                🎧
              </a>
              {chains.has(s.id) && (
                <a
                  title="Voice FX: denoise, gate, EQ, compressor"
                  style={{ cursor: 'pointer', color: fxOpen === s.id ? 'var(--accent2)' : 'var(--dim)', float: 'right', marginRight: 6 }}
                  onClick={() => setFxOpen(fxOpen === s.id ? null : s.id)}
                >
                  🎚️
                </a>
              )}
            </div>
            <input
              type="range" min="0" max="1.5" step="0.01" defaultValue="1"
              disabled={muted[s.id]}
              onChange={(e) => mixer.setGain(s.id, Number(e.target.value))}
            />
            <div className="meter"><i style={{ width: `${Math.min(100, mixer.peak(s.id) * 140)}%` }} /></div>
            {fxOpen === s.id && fxMap[s.id] && (
              <div
                style={{
                  position: 'fixed', bottom: 110, left: 16, width: 280, zIndex: 60,
                  background: '#15151d', border: '1px solid #333', borderRadius: 10,
                  padding: 12, boxShadow: '0 8px 30px rgba(0,0,0,.55)',
                  maxHeight: '70vh', overflowY: 'auto',
                  fontSize: 12, display: 'grid', gap: 6,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <b>🎚️ {s.label}</b>
                  <span style={{ display: 'flex', gap: 10 }}>
                    <a
                      title="Reset to the tuned broadcast defaults"
                      style={{ cursor: 'pointer', color: 'var(--accent2)' }}
                      onClick={() => updateFx(s.id, { ...DEFAULT_FX })}
                    >↺ optimal</a>
                    <a style={{ cursor: 'pointer', color: 'var(--dim)' }} onClick={() => setFxOpen(null)}>✕</a>
                  </span>
                </div>
                <label>🎚 Input trim · {fxMap[s.id].inputDb > 0 ? '+' : ''}{fxMap[s.id].inputDb} dB</label>
                <input
                  type="range" min="-12" max="12" step="1" value={fxMap[s.id].inputDb}
                  onChange={(e) => updateFx(s.id, { inputDb: Number(e.target.value) })}
                />
                {s.kind === 'mic' && (
                  <label style={{ cursor: 'pointer' }} title="Cancels your speakers' sound re-entering the mic. On/off only — Chromium AEC has no strength setting. Turn off on headphones.">
                    <input type="checkbox" checked={fxMap[s.id].echoCancel} onChange={(e) => updateFx(s.id, { echoCancel: e.target.checked })} /> 🔁 Echo cancel (speakers)
                  </label>
                )}
                <label style={{ cursor: 'pointer', opacity: chains.get(s.id)?.denoiseAvailable ? 1 : 0.4 }}>
                  <input
                    type="checkbox" checked={fxMap[s.id].denoise} disabled={!chains.get(s.id)?.denoiseAvailable}
                    onChange={(e) => updateFx(s.id, { denoise: e.target.checked })}
                  /> ✨ Denoise · {Math.round(fxMap[s.id].denoiseStrength * 100)}%{!chains.get(s.id)?.denoiseAvailable && ' — unavailable'}
                </label>
                <input
                  type="range" min="0" max="1" step="0.05" value={fxMap[s.id].denoiseStrength}
                  disabled={!fxMap[s.id].denoise}
                  onChange={(e) => updateFx(s.id, { denoiseStrength: Number(e.target.value) })}
                />
                <label style={{ cursor: 'pointer' }} title="Smooth expander — reduces room noise between phrases to −20dB (never hard-mutes).">
                  <input type="checkbox" checked={fxMap[s.id].gate} onChange={(e) => updateFx(s.id, { gate: e.target.checked })} /> 🚪 Gate · {fxMap[s.id].gateDb} dB
                </label>
                <input
                  type="range" min="-70" max="-25" step="1" value={fxMap[s.id].gateDb}
                  disabled={!fxMap[s.id].gate}
                  onChange={(e) => updateFx(s.id, { gateDb: Number(e.target.value) })}
                />
                <label>🌊 Low cut · {fxMap[s.id].lowCut} Hz</label>
                <input
                  type="range" min="40" max="160" step="5" value={fxMap[s.id].lowCut}
                  onChange={(e) => updateFx(s.id, { lowCut: Number(e.target.value) })}
                />
                <label>
                  🎛️ EQ preset{' '}
                  <select
                    value={fxMap[s.id].preset}
                    onChange={(e) => {
                      const p = e.target.value as VoiceFx['preset'];
                      const [lo, mud, pres, air] = presetBands(p);
                      updateFx(s.id, { preset: p, eqLow: lo, eqMud: mud, eqPresence: pres, eqAir: air });
                    }}
                  >
                    <option value="broadcast">Broadcast</option>
                    <option value="warm">Warm</option>
                    <option value="bright">Bright</option>
                    <option value="flat">Flat</option>
                  </select>
                </label>
                {([['eqLow', 'Low · 120 Hz'], ['eqMud', 'Mud · 250 Hz'], ['eqPresence', 'Presence · 3 kHz'], ['eqAir', 'Air · 12 kHz']] as const).map(([k, lbl]) => (
                  <React.Fragment key={k}>
                    <label>{lbl} · {fxMap[s.id][k] > 0 ? '+' : ''}{fxMap[s.id][k]} dB</label>
                    <input
                      type="range" min="-12" max="12" step="0.5" value={fxMap[s.id][k]}
                      onChange={(e) => updateFx(s.id, { [k]: Number(e.target.value) } as Partial<VoiceFx>)}
                    />
                  </React.Fragment>
                ))}
                <label style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={fxMap[s.id].deEss} onChange={(e) => updateFx(s.id, { deEss: e.target.checked })} /> 🦷 De-ess · −{fxMap[s.id].deEssDb} dB
                </label>
                <input
                  type="range" min="2" max="12" step="1" value={fxMap[s.id].deEssDb}
                  disabled={!fxMap[s.id].deEss}
                  onChange={(e) => updateFx(s.id, { deEssDb: Number(e.target.value) })}
                />
                <label style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={fxMap[s.id].comp} onChange={(e) => updateFx(s.id, { comp: e.target.checked })} /> 🗜️ Compressor · {Math.round(fxMap[s.id].compAmount * 100)}%
                </label>
                <input
                  type="range" min="0" max="1" step="0.05" value={fxMap[s.id].compAmount}
                  disabled={!fxMap[s.id].comp}
                  onChange={(e) => updateFx(s.id, { compAmount: Number(e.target.value) })}
                />
                <label>Makeup gain · +{fxMap[s.id].makeupDb} dB</label>
                <input
                  type="range" min="0" max="12" step="1" value={fxMap[s.id].makeupDb}
                  disabled={!fxMap[s.id].comp}
                  onChange={(e) => updateFx(s.id, { makeupDb: Number(e.target.value) })}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {picker !== 'none' && (
        <div className="modal-bg" onClick={() => setPicker('none')}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {picker === 'screen' && (
              <>
                <h3>Pick a display or window</h3>
                <div className="grid">
                  {captureList.map((c) => (
                    <div
                      className="pick" key={c.id}
                      onClick={() => addSource(() => new ScreenSource(mixer.ctx, c.id, c.name, c.isScreen))}
                    >
                      <img src={c.thumbnail} />
                      <div>{c.isScreen ? '🖥 ' : '🪟 '}{c.name}</div>
                    </div>
                  ))}
                </div>
                <div className="hint">Displays include system audio; single windows are video-only (Windows limitation).</div>
              </>
            )}
            {picker === 'phone' && linkInfo && (
              <>
                <h3>Link your phone</h3>
                <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
                  {linkQr && <img src={linkQr} style={{ borderRadius: 8, background: '#fff' }} />}
                  <div>
                    <p>In ScreenCap on your phone, open <b>Desktop Link</b> and enter:</p>
                    <p style={{ margin: '10px 0', fontSize: 16 }}>
                      Host: <b>{linkInfo.ips.join(' or ')}</b><br />
                      Port: <b>{linkInfo.port}</b><br />
                      Code: <b style={{ letterSpacing: 2 }}>{linkInfo.code}</b>
                    </p>
                    <p style={{ color: phoneConnected ? '#43a047' : 'var(--dim)' }}>
                      {phoneConnected ? '✓ Phone connected' : 'Waiting for the phone… (both devices must be on the same Wi-Fi)'}
                    </p>
                    {phoneConnected && (
                      <button
                        className="btn rec" style={{ marginTop: 10 }}
                        onClick={() =>
                          addSource(() => new PhoneSource(mixer.ctx, linkInfo.port, linkInfo.code ?? ''))
                        }
                      >
                        Add phone camera to sources
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
            {(picker === 'webcam' || picker === 'mic') && (
              <>
                <h3>Pick a {picker === 'webcam' ? 'camera' : 'microphone'}</h3>
                {deviceList.map((d) => (
                  <div
                    className="card" key={d.deviceId}
                    onClick={() =>
                      addSource(() =>
                        picker === 'webcam'
                          ? new WebcamSource(mixer.ctx, d.deviceId, d.label || 'Camera')
                          : new MicSource(mixer.ctx, d.deviceId, d.label || 'Microphone'),
                      )
                    }
                  >
                    {d.label || d.deviceId.slice(0, 12)}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
