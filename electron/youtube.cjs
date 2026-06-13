/**
 * YouTubeService — main-process YouTube Live integration. Tokens and the OAuth client secret
 * never leave this process; they are encrypted at rest with Electron safeStorage (Windows DPAPI).
 *
 * Desktop OAuth: loopback redirect + PKCE (Google forbids embedded webviews). The operator
 * supplies their own Google Cloud "Desktop app" OAuth client (id + secret) — a desktop client
 * secret is not confidential, and PKCE protects the exchange.
 */
const { app, shell, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class YouTubeService {
  constructor() {
    this.credPath = path.join(app.getPath('userData'), 'yt-credentials.bin');
    this.tokenPath = path.join(app.getPath('userData'), 'yt-token.bin');
    this.clientId = null;
    this.clientSecret = null;
    this.refreshToken = null;
    this.accessTokenValue = null;
    this.accessExpiry = 0;
    this.channel = null; // { id, title }
    this.chat = null; // active poll loop state
    this.serverSkewMs = 0; // (server clock − local clock); the local clock can't be trusted
    this._load();
  }

  // ---- encrypted persistence ----
  _enc(obj) {
    const json = JSON.stringify(obj);
    if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(json);
    return Buffer.from('plain:' + json, 'utf8'); // dev fallback; flagged in status
  }
  _dec(buf) {
    if (buf.slice(0, 6).toString('utf8') === 'plain:') return JSON.parse(buf.slice(6).toString('utf8'));
    return JSON.parse(safeStorage.decryptString(buf));
  }
  _load() {
    try {
      if (fs.existsSync(this.credPath)) {
        const c = this._dec(fs.readFileSync(this.credPath));
        this.clientId = c.clientId;
        this.clientSecret = c.clientSecret;
      }
    } catch {}
    try {
      if (fs.existsSync(this.tokenPath)) {
        const t = this._dec(fs.readFileSync(this.tokenPath));
        this.refreshToken = t.refreshToken;
        this.channel = t.channel || null;
      }
    } catch {}
  }

  setCredentials(clientId, clientSecret) {
    this.clientId = (clientId || '').trim();
    this.clientSecret = (clientSecret || '').trim();
    fs.writeFileSync(this.credPath, this._enc({ clientId: this.clientId, clientSecret: this.clientSecret }));
    return this.getStatus();
  }

  getStatus() {
    return {
      hasCreds: !!(this.clientId && this.clientSecret),
      signedIn: !!this.refreshToken,
      channelTitle: this.channel?.title || null,
      channelId: this.channel?.id || null,
      encrypted: safeStorage.isEncryptionAvailable(),
    };
  }

  signOut() {
    this.refreshToken = null;
    this.accessTokenValue = null;
    this.channel = null;
    try { fs.unlinkSync(this.tokenPath); } catch {}
    this.chatStop();
    return this.getStatus();
  }

  // ---- OAuth (loopback + PKCE) ----
  async signIn() {
    if (!this.clientId || !this.clientSecret) throw new Error('Set your Google OAuth client ID and secret first');
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (!u.searchParams.get('code') && !u.searchParams.get('error')) {
          res.writeHead(404); res.end(); return;
        }
        const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:system-ui;background:#0e1015;color:#eee;text-align:center;padding-top:80px">
          <h2>${ok ? '✓ ScreenCap Studio is connected' : '✗ Sign-in failed'}</h2>
          <p>You can close this tab and return to the Studio.</p></body></html>`);
        server.close();
        const err = u.searchParams.get('error');
        if (err) return reject(new Error(err));
        if (u.searchParams.get('state') !== state) return reject(new Error('state mismatch'));
        resolve(u.searchParams.get('code'));
      });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        this._redirectUri = `http://127.0.0.1:${port}`;
        const params = new URLSearchParams({
          client_id: this.clientId,
          redirect_uri: this._redirectUri,
          response_type: 'code',
          scope: SCOPE,
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
        });
        shell.openExternal(`${AUTH_URL}?${params.toString()}`);
      });
      setTimeout(() => { try { server.close(); } catch {}; reject(new Error('sign-in timed out')); }, 300_000);
    });

    const tok = await this._tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this._redirectUri,
      code_verifier: verifier,
    });
    this.refreshToken = tok.refresh_token;
    this._setAccess(tok);
    await this._fetchChannel();
    fs.writeFileSync(this.tokenPath, this._enc({ refreshToken: this.refreshToken, channel: this.channel }));
    return this.getStatus();
  }

  _setAccess(tok) {
    this.accessTokenValue = tok.access_token;
    this.accessExpiry = Date.now() + (tok.expires_in - 60) * 1000; // 60s safety margin
  }

  // The local clock is wrong relative to Google (this machine runs in the future). Derive
  // a true "now" from the server's Date header so scheduledStartTime is valid.
  _captureSkew(r) {
    const d = r.headers.get('date');
    if (d) { const t = Date.parse(d); if (!isNaN(t)) this.serverSkewMs = t - Date.now(); }
  }
  serverNow() {
    return Date.now() + this.serverSkewMs;
  }

  async _tokenRequest(extra) {
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...extra });
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    this._captureSkew(r);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.error || `token ${r.status}`);
    return j;
  }

  async accessToken() {
    if (this.accessTokenValue && Date.now() < this.accessExpiry) return this.accessTokenValue;
    if (!this.refreshToken) throw new Error('not signed in');
    const tok = await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: this.refreshToken });
    this._setAccess(tok);
    return this.accessTokenValue;
  }

  // ---- API wrapper: bearer inject, 401-refresh-retry, typed quota error, 5xx backoff ----
  async apiFetch(url, opts = {}, _retry = 0) {
    const token = await this.accessToken();
    const r = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (r.status === 401 && _retry === 0) {
      this.accessExpiry = 0; // force refresh
      return this.apiFetch(url, opts, 1);
    }
    if (r.status >= 500 && _retry < 3) {
      await new Promise((res) => setTimeout(res, 500 * 2 ** _retry));
      return this.apiFetch(url, opts, _retry + 1);
    }
    this._captureSkew(r);
    const text = await r.text();
    const j = text ? JSON.parse(text) : {};
    if (!r.ok) {
      const reason = j.error?.errors?.[0]?.reason || j.error?.status || r.status;
      const e = new Error(j.error?.message || `api ${r.status}`);
      e.reason = reason;
      throw e;
    }
    return j;
  }

  async _fetchChannel() {
    const j = await this.apiFetch(`${API}/channels?part=snippet&mine=true`);
    const c = j.items?.[0];
    this.channel = c ? { id: c.id, title: c.snippet.title } : null;
  }

  // ---- broadcast control ----
  async listBroadcasts() {
    const j = await this.apiFetch(
      `${API}/liveBroadcasts?part=snippet,status,contentDetails&broadcastStatus=upcoming&maxResults=20&mine=true`,
    );
    const active = await this.apiFetch(
      `${API}/liveBroadcasts?part=snippet,status,contentDetails&broadcastStatus=active&maxResults=10&mine=true`,
    );
    return [...(active.items || []), ...(j.items || [])].map((b) => ({
      id: b.id,
      title: b.snippet.title,
      privacy: b.status.privacyStatus,
      lifeCycle: b.status.lifeCycleStatus,
      liveChatId: b.snippet.liveChatId,
      scheduledStartTime: b.snippet.scheduledStartTime,
    }));
  }

  async createBroadcast({ title, description, privacy, scheduledStartTime, latency }) {
    // Refresh server skew right before building the body (cheap, ~1 quota unit). The local
    // clock is in the future, so scheduledStartTime MUST be derived from the server's clock.
    try { await this._fetchChannel(); } catch {}
    const body = {
      snippet: {
        title: title || 'ScreenCap Studio Live',
        description: description || '',
        // "Now + 30s" on the SERVER clock — instant go-live, valid against YouTube's date.
        scheduledStartTime: scheduledStartTime || new Date(this.serverNow() + 30_000).toISOString(),
      },
      status: { privacyStatus: privacy || 'unlisted', selfDeclaredMadeForKids: false },
      contentDetails: {
        // Auto-start: YouTube flips the broadcast to live the moment it receives the
        // ingest — no manual transition (which hit "Invalid transition" with the default
        // monitor/testing phase). Monitor stream off = ready→live directly.
        enableAutoStart: true,
        enableAutoStop: true,
        enableDvr: true,
        latencyPreference: latency || 'normal', // normal | low | ultraLow
        monitorStream: { enableMonitorStream: false },
      },
    };
    const j = await this.apiFetch(`${API}/liveBroadcasts?part=snippet,status,contentDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { id: j.id, liveChatId: j.snippet.liveChatId, title: j.snippet.title };
  }

  /** Our OWN dedicated reusable stream (NOT YouTube's "Default stream", which collides
   *  with the channel's built-in Stream-now and triggers "key currently assigned"). */
  async getOrCreateStream() {
    const list = await this.apiFetch(`${API}/liveStreams?part=snippet,cdn,status&mine=true&maxResults=50`);
    let s = (list.items || []).find(
      (x) => x.snippet?.title === 'ScreenCap Studio' && x.cdn?.ingestionInfo?.streamName,
    );
    if (!s) {
      s = await this.apiFetch(`${API}/liveStreams?part=snippet,cdn,contentDetails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snippet: { title: 'ScreenCap Studio' },
          cdn: { frameRate: '30fps', ingestionType: 'rtmp', resolution: '1080p' },
          contentDetails: { isReusable: true },
        }),
      });
    }
    return {
      streamId: s.id,
      ingestionAddress: s.cdn.ingestionInfo.ingestionAddress,
      streamName: s.cdn.ingestionInfo.streamName,
    };
  }

  async bind(broadcastId, streamId) {
    return this.apiFetch(
      `${API}/liveBroadcasts/bind?id=${broadcastId}&streamId=${streamId}&part=id,status`,
      { method: 'POST' },
    );
  }

  async getBroadcastStatus(broadcastId) {
    const j = await this.apiFetch(`${API}/liveBroadcasts?part=status&id=${broadcastId}`);
    return j.items?.[0]?.status || {};
  }

  async streamHealth(streamId) {
    const j = await this.apiFetch(`${API}/liveStreams?part=status&id=${streamId}`);
    return j.items?.[0]?.status?.streamStatus || 'inactive'; // active when ingest is flowing
  }

  async transition(broadcastId, status) {
    return this.apiFetch(
      `${API}/liveBroadcasts/transition?broadcastStatus=${status}&id=${broadcastId}&part=id,status`,
      { method: 'POST' },
    );
  }

  /** Full one-shot: create+bind a stream, return everything the streamer needs. */
  async prepareStream(broadcastId) {
    const s = await this.getOrCreateStream();
    await this.bind(broadcastId, s.streamId);
    return s; // { streamId, ingestionAddress, streamName }
  }

  deleteBroadcast(id) {
    return this.apiFetch(`${API}/liveBroadcasts?id=${id}`, { method: 'DELETE' });
  }

  async _listNonComplete() {
    const out = [];
    for (const st of ['upcoming', 'active']) {
      try {
        const j = await this.apiFetch(
          `${API}/liveBroadcasts?part=snippet,status,contentDetails&broadcastStatus=${st}&maxResults=50&mine=true`,
        );
        out.push(...(j.items || []));
      } catch {}
    }
    return out;
  }

  /** Free the reusable stream: complete any live leftovers, delete pre-live ones still
   *  bound to it (the "stream key is currently assigned" error comes from this pile).
   *  Scoped to broadcasts ACTUALLY bound to our stream — deleting every same-titled
   *  broadcast burned Data-API quota (50 units each) during repeated test go-lives. */
  async _cleanupBoundBroadcasts(streamId, exceptId) {
    const all = await this._listNonComplete();
    for (const b of all) {
      if (b.id === exceptId) continue;
      if (b.contentDetails?.boundStreamId !== streamId) continue;
      const lc = b.status?.lifeCycleStatus;
      try {
        if (lc === 'live' || lc === 'liveStarting') await this.transition(b.id, 'complete');
        else await this.deleteBroadcast(b.id);
      } catch {}
    }
  }

  /** One call the UI uses to go live: free the stream, create a fresh broadcast, bind it. */
  async prepareLive(opts) {
    const stream = await this.getOrCreateStream();
    await this._cleanupBoundBroadcasts(stream.streamId, null);
    const b = await this.createBroadcast(opts);
    await this.bind(b.id, stream.streamId);
    return {
      broadcastId: b.id,
      liveChatId: b.liveChatId,
      streamId: stream.streamId,
      ingestionAddress: stream.ingestionAddress,
      streamName: stream.streamName,
    };
  }

  // ---- chat + moderation ----
  chatStart(liveChatId, onMessages) {
    this.chatStop();
    const state = { stop: false, pageToken: undefined, liveChatId };
    this.chat = state;
    const loop = async () => {
      if (state.stop) return;
      try {
        const params = new URLSearchParams({
          liveChatId,
          part: 'snippet,authorDetails',
          maxResults: '200',
        });
        if (state.pageToken) params.set('pageToken', state.pageToken);
        const j = await this.apiFetch(`${API}/liveChat/messages?${params.toString()}`);
        state.pageToken = j.nextPageToken;
        const msgs = (j.items || []).map((m) => ({
          id: m.id,
          authorName: m.authorDetails.displayName,
          authorChannelId: m.authorDetails.channelId,
          text: m.snippet.displayMessage || '',
          isMod: m.authorDetails.isChatModerator,
          isOwner: m.authorDetails.isChatOwner,
          isSuperChat: m.snippet.type === 'superChatEvent',
          amount: m.snippet.superChatDetails?.amountDisplayString || null,
          publishedAt: m.snippet.publishedAt,
        }));
        if (msgs.length) onMessages(msgs);
        const wait = Math.max(3000, j.pollingIntervalMillis || 5000);
        state.timer = setTimeout(loop, state.backoff ? wait * 2 : wait);
        state.backoff = false;
      } catch (e) {
        if (e.reason === 'quotaExceeded' || e.reason === 'rateLimitExceeded') state.backoff = true;
        if (e.message === 'liveChatEnded' || e.reason === 'liveChatEnded') return;
        state.timer = setTimeout(loop, 10_000);
      }
    };
    loop();
  }

  chatStop() {
    if (this.chat) {
      this.chat.stop = true;
      clearTimeout(this.chat.timer);
      this.chat = null;
    }
  }

  async chatSend(liveChatId, text) {
    return this.apiFetch(`${API}/liveChat/messages?part=snippet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } },
      }),
    });
  }

  chatDelete(messageId) {
    return this.apiFetch(`${API}/liveChat/messages?id=${messageId}`, { method: 'DELETE' });
  }

  ban(liveChatId, channelId, seconds) {
    const body = {
      snippet: {
        liveChatId,
        type: seconds ? 'temporary' : 'permanent',
        bannedUserDetails: { channelId },
        ...(seconds ? { banDurationSeconds: seconds } : {}),
      },
    };
    return this.apiFetch(`${API}/liveChat/bans?part=snippet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  addModerator(liveChatId, channelId) {
    return this.apiFetch(`${API}/liveChat/moderators?part=snippet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippet: { liveChatId, moderatorDetails: { channelId } } }),
    });
  }

  async setThumbnail(broadcastId, filePath) {
    const data = fs.readFileSync(filePath);
    const token = await this.accessToken();
    const r = await fetch(`${UPLOAD}/thumbnails/set?videoId=${broadcastId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
      body: data,
    });
    if (!r.ok) throw new Error(`thumbnail ${r.status}`);
    return r.json();
  }
}

module.exports = { YouTubeService };
