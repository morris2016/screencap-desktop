# Studio Go-LIVE — industrial stability plan

**Evidence (stream log, 9 failed attempts):** ffmpeg encoded at 1.6–11 fps vs the required 30 —
`-re` throttles input reads to "native rate", which on a LIVE PIPE double-throttles, backs the
pipe up, and collapses every session ("Conversion failed!" ×9). Secondary: no supervision (any
exit is final), no live health (failures invisible until post-mortem), a dead pipe could crash
the app (fixed), no restart protocol for the capture side.

## Fixes (all in this build)

1. **Kill `-re`** — the root defect. Live pipes are already real-time; ffmpeg must read as fast
   as data arrives. Add `-fflags nobuffer` for fast start. Encoder preset → `superfast` +
   `zerolatency` (CPU headroom guarantees ≥30fps at 1080p).
2. **Supervisor + auto-restart:** unexpected ffmpeg exit while live → backoff restart (1s→2s→4s→
   8s→15s, 5 attempts, stable-streak reset — the proven Android ReconnectPolicy ported). The
   renderer restarts its MediaRecorder on 'stream-restarting' so each ffmpeg gets a fresh
   container header. YouTube tolerates short ingest gaps; viewers see a hiccup, not an ending.
3. **Live health feed:** parse ffmpeg's `frame= fps= bitrate= speed=` progress (1Hz) → HUD line
   `🔴 LIVE · kbps · fps · speed`. `speed < 1.0x` is the early-warning that encoding is falling
   behind — surfaced live, not in a post-mortem.
4. **Pipeline watchdog:** speed < 0.9× sustained 10s, or no progress for 5s → treat as a fault →
   supervised restart (counts as a reconnect).
5. **Pre-flight:** ffmpeg presence, URL shape (`rtmp(s)://…`), non-empty key — checked BEFORE
   going live with clear messages.
6. **Local test mode:** a `Test` button streams to `rtmp://127.0.0.1:19350/live/test` — the same
   closed-loop harness that validated the Android stack (PC ffmpeg listener + analyzer verdict),
   zero YouTube dependency.

## Verification
Local round: listener records the test stream ≥60s → `analyze_recording.ps1` must read CLEAN
(steady bitrate, no gaps) + health HUD shows speed ≈1.0×. Chaos: kill ffmpeg mid-stream → auto
restart within backoff, HUD reconnect counter increments. Then the YouTube round with a fresh key.
