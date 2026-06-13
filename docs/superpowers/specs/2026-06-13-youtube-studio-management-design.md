# YouTube Studio Management — Master Program Spec

**Date:** 2026-06-13
**App:** ScreenCap Studio (Electron desktop broadcast app, `C:\Users\fame\Documents\bin\screencap-desktop`)
**Status:** approved architecture; subsystems built step-by-step (① → ② → ③).

## 1. Goal

Add a broadcast-management layer so the operator can run a real YouTube live show from inside
the Studio: control the broadcast, moderate the audience, bring on remote guests, and dress the
stage with overlays — without ever opening studio.youtube.com.

## 2. Guiding principle

**YouTube owns the broadcast; the Studio owns the stage.** Two of the four capabilities are
backed by real YouTube APIs (broadcast control, chat/moderation); the other two are built on the
Studio's own infrastructure (guests extend Phone Link; overlays extend the compositor). All of it
exits through the single native ffmpeg stream hardened earlier (ddagrab/QSV + dshow + voice chain).

## 3. Architecture

```
 Guests (browser via WebRTC / phone via Phone Link) ─────────────┐
                                                                 ▼
 Screen + cam ──►  BROADCAST WINDOW  ◄── overlays ── mixer ──►  native ffmpeg ──► YouTube RTMP ingest
                   (compositor canvas)                              ▲                    ▲
                                                                    │ auto stream key    │ go-live/end
 YouTube Service (main process) ── OAuth · broadcasts · chat · moderation ───────────────┘
```

### 3.1 Process split

- **Main process (Node):** YouTube service (OAuth, Data API, chat polling), WebRTC signaling relay
  (extends the existing `ws` server), native ffmpeg supervisor (existing). Tokens and secrets never
  reach the renderer; no CORS; encrypted at rest via Electron `safeStorage` (Windows DPAPI).
- **Broadcast window (renderer, dedicated):** the compositor, overlay layer, mixer, and guest
  `RTCPeerConnection`s. **Why a dedicated window:** once guests/overlays exist, the broadcast video
  is the *composited canvas*, not the raw screen — and a canvas in the main UI window is throttled
  the instant the user minimizes it (the exact bug the audio panel diagnosed). A dedicated,
  never-minimized window (offscreen or always-shown), held awake by `powerSaveBlocker` +
  `backgroundThrottling:false`, makes compositing throttle-immune. The main window becomes a pure
  control surface that talks to it over `MessageChannel`/IPC.
- **Main UI window (renderer):** controls only — sign-in, broadcast setup, stage roster, chat,
  overlay triggers. Safe to minimize.

> **Migration note:** subsystem ① ships *without* the broadcast-window refactor (solo broadcasting
> already runs fully native and is throttle-proof). The refactor is introduced by subsystem ②, when
> guest compositing first requires it. ① and the existing app are unaffected.

## 4. Subsystems (build order)

### ① YouTube layer — OAuth + broadcast control + chat/moderation  *(foundation)*
See the detailed spec: `2026-06-13-youtube-layer-design.md`. Summary:
- OAuth 2.0 desktop flow (system browser + loopback redirect + PKCE; embedded Google login is
  forbidden by Google). Scope `https://www.googleapis.com/auth/youtube.force-ssl`.
- `liveBroadcasts` (create / title / description / privacy / thumbnail / transition lifecycle) +
  `liveStreams` (**auto-fetch rtmp ingest + stream key** — eliminates manual key copy/reset).
- Chat: `liveChatMessages.list` (honor `pollingIntervalMillis`) + `.insert`; `liveChatBans`
  (timeout/ban) + `.delete`; `liveChatModerators` (list/insert/delete).
- **Setup prerequisite (documented, unavoidable for a desktop app):** the operator supplies an
  OAuth **client ID + secret** from their own Google Cloud project (YouTube Data API v3 enabled,
  "Desktop app" credential). Consent screen runs in *testing* mode with the operator as a test
  user unless Google-verified. Stored encrypted via `safeStorage`.
- **Quota:** Data API default 10,000 units/day. `liveChatMessages.list` = ~1 unit/call (respect the
  server-provided poll interval); `insert`/`ban` ≈ 50 units. The UI surfaces remaining quota and
  backs off on `quotaExceeded`.

### ② Stage / green room / guests  *(differentiator)*
- Participant model: `{ id, name, role: host|guest, transport: phone|webrtc, media, state:
  greenroom|stage, slot }`.
- **Phones** keep the existing Phone Link binary protocol. **Browser guests** open a join URL →
  WebRTC (STUN for same-network/easy-NAT; TURN documented as the internet-scaling cost). Signaling
  rides the existing `ws` server.
- Green room (host previews, off-air) → "Add to stage" → video joins auto-layout + audio joins
  mixer. Auto-layouts by headcount (solo / side-by-side / grid / spotlight / PiP-with-screen),
  host drag-override via existing compositor hit-testing.
- Introduces the **broadcast-window refactor** (§3.1).
- **Hardest problem (flagged):** guest return audio / mix-minus (guests must hear the show minus
  their own voice to avoid echo). v1 leans on browser AEC; full per-guest mix-minus is a later
  milestone.

### ③ Overlays / lower-thirds / ticker / pinned chat  *(polish)*
- Top z-layer in the compositor, data-driven + themeable: animated lower-thirds, auto name-tags per
  stage slot, scrolling ticker, logo/brand frame, **pin-a-chat-message-on-screen** (from ①),
  full-screen "Starting soon / BRB" cards.
- Broadcast-grade visual design (not default styling).

### ④ Cutover
- Manual url+key path demoted to "Custom RTMP (advanced)"; "Go Live to YouTube" becomes the
  one-click default.

## 5. Cross-cutting concerns

- **Error handling:** OAuth refresh failure → re-auth prompt; API `403 quotaExceeded` → surfaced
  banner + chat-poll backoff; broadcast transition races → poll `status` before transitioning;
  guest disconnect → auto-remove from stage, keep show running; network drop → existing supervised
  ffmpeg restart ladder.
- **Security:** OAuth client secret + refresh token encrypted (`safeStorage`); tokens main-only;
  join URLs carry a single-use signed token; no secret ever logged (continue the stream-key
  redaction discipline).
- **Testing:** YouTube service unit-tested against recorded API fixtures; OAuth loopback tested with
  a stub authorization server; quota/backoff logic unit-tested; manual E2E against a real unlisted
  broadcast per subsystem.

## 6. Sequencing

① → ② → ③ → ④. Each is its own spec → plan → build. ① is foundational (auth seeds chat; auto-key
seeds the cutover). ② and ③ both build on the broadcast window/compositor; ② introduces it, ③
decorates it. Implement and verify each before starting the next.
