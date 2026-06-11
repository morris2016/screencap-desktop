import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Compositor, presetScenes } from './engine/compositor';
import { Mixer } from './engine/mixer';
import { Recorder } from './engine/recorder';
import { MicSource, ScreenSource, WebcamSource } from './engine/sources';
import type { CaptureSourceInfo, Scene, SceneItem, Source } from './engine/types';

type Picker = 'none' | 'screen' | 'webcam' | 'mic';

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

  // Mount the compositor canvas into the preview.
  useEffect(() => {
    previewRef.current?.appendChild(compositor.canvas);
  }, [compositor]);

  // Timer + meters tick.
  useEffect(() => {
    const iv = setInterval(() => {
      setElapsed(recorder.elapsedMs);
      force((x) => x + 1); // meters redraw
    }, 200);
    return () => clearInterval(iv);
  }, [recorder]);

  // Hotkeys F1..F8 for scenes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const idx = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'].indexOf(e.key);
      if (idx >= 0 && scenes[idx]) {
        e.preventDefault();
        switchScene(scenes[idx].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function refreshScenes(srcs: Source[], keepActive = true) {
    const screen = srcs.find((s) => s.kind === 'screen');
    const cam = srcs.find((s) => s.kind === 'webcam' || s.kind === 'phone-cam');
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
      if (s.audioNode) mixer.attach(s.id, s.audioNode);
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
    if (kind === 'screen') {
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
    compositor.unregisterSource(id);
    const next = sources.filter((x) => x.id !== id);
    setSources(next);
    refreshScenes(next, false);
  }

  function toggleRecord() {
    if (recorder.state !== 'inactive') {
      recorder.stop();
      setRecState('inactive');
      return;
    }
    recorder.start(compositor.captureStream(30), mixer.stream, (saved) =>
      setStatus(saved ? `saved → ${saved}` : 'save canceled'),
    );
    setRecState('recording');
  }

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
          <button className="add" disabled title="Phone Link — next milestone">＋ Phone (Link) — soon</button>
          {sources.map((s) => (
            <div className="card" key={s.id} onContextMenu={() => removeSource(s.id)}>
              {s.label}
              <small>{s.kind} · right-click to remove</small>
            </div>
          ))}
        </div>

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
            <span className={`timer ${recState !== 'inactive' ? 'live' : ''}`}>{fmt(elapsed)}</span>
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
        </div>
      </div>

      <div className="mixer">
        {sources.filter((s) => s.audioNode).map((s) => (
          <div className="strip" key={s.id}>
            <div className="name">{s.label}</div>
            <input
              type="range" min="0" max="1.5" step="0.01" defaultValue="1"
              onChange={(e) => mixer.setGain(s.id, Number(e.target.value))}
            />
            <div className="meter"><i style={{ width: `${Math.min(100, mixer.peak(s.id) * 140)}%` }} /></div>
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
