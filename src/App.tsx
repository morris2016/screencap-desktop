import React, { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Compositor, presetScenes } from './engine/compositor';
import { Mixer } from './engine/mixer';
import { PhoneSource } from './engine/phonesource';
import { Recorder, Streamer } from './engine/recorder';
import { MicSource, ScreenSource, WebcamSource } from './engine/sources';
import { DEFAULT_FX, presetBands, VoiceChain, type VoiceFx } from './engine/voicechain';
import type { CaptureSourceInfo, LinkInfo, Scene, SceneItem, Source } from './engine/types';

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
  const [streamUrl, setStreamUrl] = useState(localStorage.getItem('streamUrl') ?? 'rtmp://a.rtmp.youtube.com/live2');
  const [directMode, setDirectMode] = useState(localStorage.getItem('directMode') !== '0');
  const [streamKey, setStreamKey] = useState(localStorage.getItem('streamKey') ?? '');
  const [live, setLive] = useState(false);
  const [audioAlert, setAudioAlert] = useState<string | null>(null);

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
    // Native-first (throttle-proof, panel plan B): direct mode + a mic in the studio →
    // ffmpeg records screen + mic + voice chain itself. Scene mode (or no mic, e.g.
    // phone-audio setups) keeps the compositor/MediaRecorder path.
    const mic = sources.find((s) => s.kind === 'mic');
    if (directMode && mic) {
      const res = await window.screencap.nativeRecordStart(
        mic.label, chains.get(mic.id)?.settings ?? null,
      );
      if (res.ok) {
        nativeRecStart.current = Date.now();
        setRecState('recording');
        setStatus('● recording (fully native: screen + mic + voice chain)');
        window.screencap.sessionActive(true);
        return;
      }
    }
    legacyRecord();
  }

  async function goLive(url: string, key: string) {
    if (live) {
      streamer.stop();
      setLive(false);
      setStatus('stream stopped');
      window.screencap.sessionActive(recorder.state !== 'inactive');
      return;
    }
    if (!key) {
      setStatus('enter your stream key first');
      return;
    }
    setStatus('starting stream…');
    // FULLY NATIVE audio (panel plan B — the throttling-proof path): when a mic is in
    // the studio, ffmpeg captures it directly via DirectShow and runs the voice chain
    // in native filters built from this mic's FX settings. No Chromium in the live path.
    const mic = directMode ? sources.find((s) => s.kind === 'mic') : undefined;
    const nativeMic = mic?.label ?? null;
    if (directMode && !nativeMic && !sources.some((s) => s.kind === 'screen')) {
      // Pipe-audio fallback only: the mixer must not be empty (field bug: YouTube
      // reported audio bitrate 0). Add system loopback audio-only.
      const caps = await window.screencap.getCaptureSources();
      const display = caps.find((c) => c.isScreen);
      if (display) await addSource(() => new ScreenSource(mixer.ctx, display.id, 'System audio', true, true));
    }
    // 6800k = YouTube's exact 1080p recommendation; CBR pads to it, so the
    // "bitrate lower than recommended" ingest warning stays silent.
    const err = await streamer.start(
      compositor.captureStream(30), mixer.stream, url, key, 6800, directMode,
      nativeMic, nativeMic && mic ? chains.get(mic.id)?.settings ?? null : null,
    );
    if (err) setStatus(`stream failed: ${err}`);
    else {
      setLive(true);
      setStatus(
        nativeMic
          ? `🔴 connecting… (FULLY NATIVE: screen + ${nativeMic} + voice chain)`
          : directMode ? '🔴 connecting… (direct native capture)' : '🔴 connecting…',
      );
      window.screencap.sessionActive(true);
    }
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

          <h2 style={{ marginTop: 14 }}>Go Live</h2>
          <input
            className="add" style={{ textAlign: 'left' }} placeholder="RTMP URL"
            value={streamUrl}
            onChange={(e) => { setStreamUrl(e.target.value); localStorage.setItem('streamUrl', e.target.value); }}
          />
          <input
            className="add" style={{ textAlign: 'left' }} placeholder="Stream key" type="password"
            value={streamKey}
            onChange={(e) => { setStreamKey(e.target.value); localStorage.setItem('streamKey', e.target.value); }}
          />
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.9, margin: '4px 0 8px', cursor: 'pointer' }}
            title="Video is captured natively by ffmpeg (Desktop Duplication) — maximum stability, streams your full screen. Untick to stream the composited scenes (phone cam, overlays) instead."
          >
            <input
              type="checkbox"
              checked={directMode}
              onChange={(e) => { setDirectMode(e.target.checked); localStorage.setItem('directMode', e.target.checked ? '1' : '0'); }}
            />
            🖥️ Direct native capture (most stable — streams full screen, not scenes)
          </label>
          <button className="add" onClick={testLocal}>🧪 Test stream (local harness)</button>
        </div>

        {audioAlert && (
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
        {sources.filter((s) => s.audioNode).length === 0 && (
          <small style={{ color: 'var(--dim)', alignSelf: 'center' }}>
            Audio strips appear here (mic, system audio).
          </small>
        )}
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
