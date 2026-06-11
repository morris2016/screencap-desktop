# ScreenCap Studio — Desktop v1.0 Design (intensive)

**Date:** 2026-06-11 · **Status:** Approved (standing directive)
**Premise:** we own BOTH ends — the Android ScreenCap app and the desktop. Nobody else building a
desktop recorder owns the phone side. The flagship feature is therefore a **first-party Phone
Link**: the phone's camera, screen, and mic become wireless desktop sources with zero third-party
apps. The desktop becomes the **broadcast station**: phone sends camera → PC composes scenes →
PC records AND streams to YouTube on the PC's strong uplink (measured 10.5 Mbps vs the phone's
throttled guest Wi-Fi — this directly solves the live-stability story).

---

## 1. Architecture

```
┌─ Android ScreenCap (existing app, new "Desktop Link" mode) ─────────────┐
│ CameraX (front/back) ─► MediaCodec H264 ─┐                              │
│ MediaProjection screen ─► H264 (existing)├─► LinkClient (WebSocket)     │
│ Mic ─► AAC (existing pipeline)          ─┘    AVCC frames + AAC + stats │
└──────────────────────────────────────────────────┬──────────────────────┘
                                       LAN (QR pairing, token auth)
┌─ ScreenCap Studio (Electron + Vite + React + TS) ─▼──────────────────────┐
│ LinkServer (ws) ─► WebCodecs VideoDecoder/AudioDecoder ─► PhoneSource    │
│ Sources: Screen(display/window) · PC webcam · Phone cam · Phone screen   │
│          · Mic · System audio · Phone mic · Image/logo · Text overlay    │
│ Compositor: 1080p/4K canvas, drag/resize layouts, preset+custom scenes,  │
│             cut/fade transitions, hotkeys                                │
│ Audio mixer: per-source faders + meters + master limiter                 │
│ Outputs: MP4 recording (ffmpeg sidecar) · RTMP live out (ffmpeg pipe)    │
│          · screenshots · recordings library                              │
└───────────────────────────────────────────────────────────────────────────┘
```

## 2. Phone Link protocol (ours, no third party)

- **Transport:** WebSocket on the LAN. Desktop runs `LinkServer` on a fixed port; pairing via a
  **QR code** the desktop shows (`ws://<ip>:8444?token=<random>`); the phone's existing camera
  permission scans it (manual IP+code fallback). Token required; sessions expire.
- **Framing (binary):** `[1B type][1B flags][8B ptsUs][4B len][payload]`
  - `0 CONFIG` JSON: video codec + avcC (sps/pps), audio cfg, device name, battery
  - `1 VIDEO` AVCC H.264 access unit (flag bit 0 = keyframe)
  - `2 AUDIO` AAC frame
  - `3 STATS` 1Hz heartbeat: fps, kbps, battery, temperature
  - `4 CONTROL` desktop→phone: switch front/back, torch, bitrate/quality, request keyframe
- **Desktop decode:** WebCodecs `VideoDecoder` (avc + description) → VideoFrames painted into the
  compositor like any other source; `AudioDecoder` (mp4a.40.2) → WebAudio graph into the mixer.
  Target glass-to-glass latency **< 300 ms**.
- **Resilience (apply the M9 lessons):** keyframe-on-connect + wall-clock keyframe cadence,
  sender-side bounded queue (never drop audio, GOP-drop video), auto-reconnect with fresh socket,
  battery/thermal surfaced in the Studio UI.
- **Phone side:** new `link/` package in the Android repo — `LinkClient`, `CameraEncoder`
  (CameraX → MediaCodec surface, reuses VideoPipeline patterns), reuse of AudioPipeline (mic-only
  mode), foreground service `DesktopLinkService`, QR scan screen. The phone keeps working as a
  standalone recorder; Link is a third mode beside Record and Go-Live.

## 3. Studio feature set

**Sources panel** — add/remove instances; each has settings:
- Screen: **display AND window picker** (not just primary), cursor on/off
- PC webcam (deviceId), Phone camera (Link), Phone screen (Link), Phone mic (Link)
- Mic + System audio (loopback)
- Image/logo (PNG, position/opacity — watermark), Text overlay (live editable, font/color)
- Media file (mp4/webm loop — intro/BRB screens)

**Scenes panel** — named scenes, each a layout of source instances:
- Presets: Screen · Camera · PiP (4 corners) · Side-by-side · Phone-vertical-center
- **Custom: drag/resize/z-order sources on the canvas**, snap guides
- Scene switcher with **hotkeys (F1..F8)** and cut/300ms-fade transitions

**Audio mixer panel** — per-source fader (−∞..+6dB), VU meters, mute/solo, master soft-limiter
(port of the proven Android knee), optional voice ducking of system audio (port of Ducker).

**Output panel**
- **Recording: real MP4** — ffmpeg sidecar (already on this PC) muxes the MediaRecorder stream
  live via stdin pipe (h264/aac in webm/matroska → remux) or post-stop fast-remux; quality
  presets 1080p30 / 1080p60 / 4K30; pause/resume; screenshots
- **Go LIVE from the desktop**: canvas+mixer → ffmpeg pipe → RTMP (YouTube key UI like Android,
  masked; keyframe 2s enforced by ffmpeg `-g`/`-force_key_frames` — no cadence bugs possible);
  stream health line (bitrate/drops) like the phone
- Recordings library: list with thumbnails, play, open-folder, delete

**App shell** — dark studio theme, persisted settings/scenes (JSON), tray icon with
record/stream toggles, single-instance lock, crash-safe temp recording recovery.

## 4. Milestones (each independently shippable)

- **D1 Foundation:** Vite+React+TS restructure of v0.1; source/compositor/mixer engine as typed
  classes; settings persistence; display+window picker. (v0.1's logic ports, not discarded.)
- **D2 Scenes:** preset + custom drag/resize layouts, z-order, hotkeys, fade transition.
- **D3 Phone Link v1:** LinkServer + QR pairing + phone `DesktopLinkService` (camera + mic),
  WebCodecs decode, PhoneSource in compositor, stats HUD, reconnect. ← the differentiator
- **D4 Audio mixer:** faders/meters/limiter/ducking.
- **D5 MP4 + library:** ffmpeg sidecar remux, presets, recordings panel.
- **D6 Desktop Go-LIVE:** ffmpeg RTMP out + health; the "phone camera → PC → YouTube" flow E2E.
- **D7 Phone screen as source + control channel** (switch camera/torch/quality from Studio).
- **D8 Polish:** tray, hotkey editor, theme, auto-recovery, installer (electron-builder).

**Verification per milestone:** unit tests for the engine classes (vitest), the proven ffmpeg
analyzer for outputs, latency measurement for the Link (timestamp overlay → camera loop test),
and the local-RTMP harness for D6.

## 5. Risks / honesty
- WebCodecs H264 needs AVCC w/ description — phone must send avcC; conversion code on phone side
  (sps/pps already extracted there for RTMP — reuse).
- Window capture loopback audio on Windows is display-wide (Electron limitation) — document.
- Wi-Fi-only Link in v1 (USB/adb later); both devices must share a LAN.
- v0.1 stays usable throughout; D-milestones land incrementally on `master`.
