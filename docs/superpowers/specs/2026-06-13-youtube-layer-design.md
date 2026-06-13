# Subsystem ① — YouTube Layer (OAuth + Broadcast Control + Chat/Moderation)

**Date:** 2026-06-13 · **Parent:** `2026-06-13-youtube-studio-management-design.md`

## Goal

Sign in with Google once, then run a YouTube broadcast end-to-end from the Studio: create the
broadcast, go live (with the stream key fetched automatically), read and moderate chat, and end —
without studio.youtube.com.

## Components

### `electron/youtube.cjs` (new) — main-process service, no renderer access

A single class `YouTubeService` with these responsibilities:

**OAuth (desktop loopback + PKCE):**
- `setCredentials(clientId, clientSecret)` — operator-supplied (their Google Cloud "Desktop app"
  credential), persisted encrypted via `safeStorage` at `userData/yt-credentials.bin`.
- `signIn()` — generate PKCE `code_verifier`/`code_challenge`; start a one-shot loopback HTTP server
  on `127.0.0.1:<ephemeral>`; open the system browser (`shell.openExternal`) to Google's auth URL
  (`scope=youtube.force-ssl`, `access_type=offline`, `prompt=consent`); capture `?code=` on the
  loopback redirect; exchange for `{access_token, refresh_token, expires_in}`; persist the refresh
  token encrypted at `userData/yt-token.bin`. Returns the channel identity (`channels.list?mine`).
- `signOut()` — wipe stored token.
- `accessToken()` — return a valid token, refreshing via `refresh_token` when `expires_in` elapsed.
- Status: `getStatus()` → `{ hasCreds, signedIn, channelTitle, channelId }`.

**Broadcast control (Data API v3):**
- `listBroadcasts()` → upcoming/active broadcasts (`liveBroadcasts.list?mine&part=snippet,status,contentDetails`).
- `createBroadcast({ title, description, privacy, scheduledStartTime, latency })` →
  `liveBroadcasts.insert`; returns `{ id, liveChatId }`.
- `getOrCreateStream()` → reuse a persistent reusable stream (`liveStreams.list?mine`) or
  `liveStreams.insert`; returns `{ streamId, ingestionAddress, streamName /* = key */ }`.
- `bind(broadcastId, streamId)` → `liveBroadcasts.bind`.
- `transition(broadcastId, status)` → `testing|live|complete` (poll `status.streamStatus==active`
  before going `live`).
- `setThumbnail(broadcastId, filePath)` → `thumbnails.set` (multipart upload).

**Chat + moderation:**
- `chatStart(liveChatId, onMessages)` — poll `liveChatMessages.list` honoring `pollingIntervalMillis`;
  emit normalized `{ id, authorName, authorChannelId, text, isMod, isOwner, isSuperChat, amount }`.
- `chatStop()`.
- `chatSend(liveChatId, text)` → `liveChatMessages.insert`.
- `chatDelete(messageId)` → `liveChatMessages.delete`.
- `timeout(liveChatId, channelId, seconds)` / `ban(liveChatId, channelId)` → `liveChatBans.insert`.
- `unban(banId)` → `liveChatBans.delete`.
- `addModerator(liveChatId, channelId)` / `removeModerator(banId)` → `liveChatModerators`.

**Resilience:** central `apiFetch()` wrapper — injects bearer token, retries once on 401 (refresh),
surfaces `403 quotaExceeded` as a typed error, exponential backoff on 5xx. Never logs tokens.

### IPC surface (main ↔ renderer), all `youtube:*`

`yt-status`, `yt-set-credentials`, `yt-sign-in`, `yt-sign-out`,
`yt-list-broadcasts`, `yt-create-broadcast`, `yt-prepare-stream` (getOrCreateStream + bind →
returns `{ingestionAddress, streamName, broadcastId, liveChatId}`), `yt-transition`,
`yt-set-thumbnail`, `yt-chat-start`/`yt-chat-stop` (push messages via `yt-chat-messages` event),
`yt-chat-send`, `yt-chat-delete`, `yt-chat-timeout`, `yt-chat-ban`, `yt-chat-unban`,
`yt-chat-add-mod`, `yt-chat-remove-mod`. Exposed on `window.screencap.yt.*` in preload; typed in
`types.ts`.

### UI (`src/App.tsx` + small components)

- **Settings → YouTube card:** paste OAuth client ID/secret (with a link + short how-to for the
  Google Cloud setup), Sign in / Sign out, signed-in channel name, quota indicator.
- **Go Live → YouTube mode:** title + privacy (public/unlisted/private) + latency; "Go Live to
  YouTube" button. On click: createBroadcast → prepare-stream (auto key) → start native ffmpeg to
  the fetched ingest+key → poll → transition `live`. End → transition `complete` + stop ffmpeg.
- **Chat panel:** live message list (mod/owner/superchat badges), composer to send as the channel,
  per-message actions (delete, timeout 10s/60s/300s, ban), moderator management.

## Data flow — go live

1. UI: createBroadcast(title,privacy) → `{broadcastId, liveChatId}`.
2. UI: prepare-stream → `{ingestionAddress, streamName}` (+ bind).
3. UI: `streamer.start(ingestionAddress, streamName, …, directMode, micDevice, fx)` — the existing
   native pipeline, now fed by the API instead of a pasted key.
4. main: poll `liveBroadcasts` until `streamStatus==active` → `transition('live')`.
5. UI: chatStart(liveChatId) → live moderation.
6. End: `transition('complete')` + `streamer.stop()`.

## Error handling

- No creds → UI gates sign-in behind the credentials form with setup instructions.
- Refresh failure / revoked → prompt re-sign-in.
- `quotaExceeded` → red banner; chat polling backs off to the server interval × 2; control calls
  disabled until reset documented.
- Transition race (`redundantTransition`/not-active) → re-poll status, retry once.
- ffmpeg ingest rejects key → existing supervised restart + surfaced error.

## Testing

- `apiFetch` retry/refresh/backoff: unit tests with a mock fetch.
- OAuth loopback: stubbed authorization-server test (code → token exchange).
- Chat normalization + poll-interval honoring: unit test against recorded `liveChatMessages` JSON.
- Manual E2E: real unlisted broadcast — sign in, create, go live (auto key), send + delete + timeout
  a chat message, end.

## Setup doc (ships in-app + README)

1. Google Cloud Console → new project → enable **YouTube Data API v3**.
2. OAuth consent screen → External → add yourself as a **test user** → scope `youtube.force-ssl`.
3. Credentials → **OAuth client ID → Desktop app** → copy client ID + secret into the Studio.
4. (Channel must be enabled for live streaming + no active strikes.)
