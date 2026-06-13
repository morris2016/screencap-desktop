import React, { useEffect, useRef, useState } from 'react';
import type { YtBroadcast, YtChatMessage, YtResult, YtStatus } from '../engine/types';

interface Props {
  live: boolean;
  startStream: (url: string, key: string) => Promise<string | null>;
  stopStream: () => void;
}

type LiveBroadcast = { id: string; liveChatId: string; streamId: string };

const yt = () => window.screencap.yt;

/** Unwrap a YtResult, surfacing the error through a setter. Returns data or null. */
async function unwrap<T>(p: Promise<YtResult<T>>, onErr: (m: string) => void): Promise<T | null> {
  const r = await p;
  if (r.ok) return r.data;
  onErr(r.reason === 'quotaExceeded' ? 'YouTube API quota exceeded for today' : r.error);
  return null;
}

export function YouTubePanel({ live, startStream, stopStream }: Props) {
  const [status, setStatus] = useState<YtStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  // credentials form
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  // broadcast form
  const [title, setTitle] = useState(localStorage.getItem('yt.title') ?? 'ScreenCap Studio Live');
  const [privacy, setPrivacy] = useState<'public' | 'unlisted' | 'private'>(
    (localStorage.getItem('yt.privacy') as 'public' | 'unlisted' | 'private') ?? 'unlisted',
  );
  const [latency, setLatency] = useState<'normal' | 'low' | 'ultraLow'>(
    (localStorage.getItem('yt.latency') as 'normal' | 'low' | 'ultraLow') ?? 'low',
  );
  // live state
  const [broadcast, setBroadcast] = useState<LiveBroadcast | null>(null);
  const [messages, setMessages] = useState<YtChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshStatus();
    yt().onChatMessages((msgs) => {
      setMessages((cur) => {
        const seen = new Set(cur.map((m) => m.id));
        const merged = [...cur, ...msgs.filter((m) => !seen.has(m.id))];
        return merged.slice(-250);
      });
    });
  }, []);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages]);

  // If the stream is stopped elsewhere while we're broadcasting, end cleanly.
  useEffect(() => {
    if (!live && broadcast) void endBroadcast();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  async function refreshStatus() {
    const s = await unwrap(yt().status(), setErr);
    if (s) {
      setStatus(s);
      setShowSetup(!s.hasCreds);
    }
  }

  async function saveCreds() {
    setErr(null);
    const s = await unwrap(yt().setCredentials(clientId, clientSecret), setErr);
    if (s) { setStatus(s); setShowSetup(false); setClientSecret(''); }
  }

  async function signIn() {
    setErr(null); setBusy('Opening Google sign-in…');
    const s = await unwrap(yt().signIn(), setErr);
    setBusy('');
    if (s) setStatus(s);
  }

  async function signOut() {
    const s = await unwrap(yt().signOut(), setErr);
    if (s) setStatus(s);
  }

  async function goLiveYouTube() {
    setErr(null);
    localStorage.setItem('yt.title', title);
    localStorage.setItem('yt.privacy', privacy);
    localStorage.setItem('yt.latency', latency);

    // One call frees the stream key (deletes stale broadcasts from earlier attempts —
    // the "stream key currently assigned" error), creates a fresh broadcast, binds it.
    setBusy('Preparing broadcast…');
    const p = await unwrap(yt().prepareLive({ title, privacy, latency }), setErr);
    if (!p) return setBusy('');

    setBusy('Starting encoder…');
    const streamErr = await startStream(p.ingestionAddress, p.streamName);
    if (streamErr) { setErr(streamErr); return setBusy(''); }

    // enableAutoStart: YouTube flips the broadcast to live as soon as it sees the ingest.
    // We just poll the broadcast lifecycle until it's actually live, then open chat.
    setBusy('Waiting for YouTube to go live…');
    const wentLive = await waitForLive(p.broadcastId);
    setBusy('');
    if (!wentLive) {
      setErr('Stream is connecting — YouTube has not gone live yet. Leave it running; it can take ~30s.');
      // keep the encoder running and still open chat; the broadcast will go live shortly
    }
    yt().chatStart(p.liveChatId);
    setMessages([]);
    setBroadcast({ id: p.broadcastId, liveChatId: p.liveChatId, streamId: p.streamId });
  }

  async function waitForLive(broadcastId: string): Promise<boolean> {
    for (let i = 0; i < 45; i++) { // ~90s
      const st = await unwrap(yt().broadcastStatus(broadcastId), setErr);
      if (st?.lifeCycleStatus === 'live') return true;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async function endBroadcast() {
    const b = broadcast;
    setBroadcast(null);
    yt().chatStop();
    if (live) stopStream();
    // enableAutoStop usually completes the broadcast when the encoder stops; this is a
    // best-effort backstop — ignore "redundant/invalid transition" if already complete.
    if (b) await yt().transition(b.id, 'complete');
  }

  // ---- chat moderation actions ----
  const liveChatId = broadcast?.liveChatId ?? '';
  const del = (m: YtChatMessage) => unwrap(yt().chatDelete(m.id), setErr);
  const timeout = (m: YtChatMessage, s: number) => unwrap(yt().chatBan(liveChatId, m.authorChannelId, s), setErr);
  const ban = (m: YtChatMessage) => unwrap(yt().chatBan(liveChatId, m.authorChannelId, null), setErr);
  const mod = (m: YtChatMessage) => unwrap(yt().chatAddMod(liveChatId, m.authorChannelId), setErr);
  async function send() {
    if (!chatInput.trim()) return;
    await unwrap(yt().chatSend(liveChatId, chatInput.trim()), setErr);
    setChatInput('');
  }

  // ---------- render ----------
  if (!status) return <div style={{ padding: 12, color: 'var(--dim)' }}>Loading YouTube…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 style={{ margin: 0 }}>📺 YouTube Live</h2>
      {err && (
        <div style={{ background: '#7f1d1d', color: '#fff', padding: '6px 10px', borderRadius: 6, fontSize: 12 }}>
          {err} <a style={{ cursor: 'pointer', float: 'right' }} onClick={() => setErr(null)}>✕</a>
        </div>
      )}

      {/* ---- sign in (prominent authorize button) ---- */}
      {!status.signedIn && (
        <button
          className="add"
          style={{ background: '#1a73e8', color: '#fff', fontWeight: 700, fontSize: 14, padding: '10px' }}
          onClick={() => (status.hasCreds ? signIn() : setShowSetup(true))}
          disabled={!!busy}
        >
          {busy || '🔑 Sign in with Google'}
        </button>
      )}
      {!status.signedIn && status.hasCreds && !showSetup && (
        <a style={{ fontSize: 11, color: 'var(--dim)', cursor: 'pointer', textAlign: 'center' }}
          onClick={() => setShowSetup(true)}>
          change Google project credentials
        </a>
      )}

      {/* ---- one-time connect: the OAuth client every YouTube app needs ---- */}
      {!status.signedIn && (showSetup || !status.hasCreds) && (
        <div className="card" style={{ fontSize: 12, display: 'grid', gap: 6 }}>
          <b>Connect your Google project (one time)</b>
          <small style={{ color: 'var(--dim)' }}>
            YouTube requires every app to use an OAuth client. Create yours once — the buttons open the exact pages.
          </small>
          <button className="add" style={{ textAlign: 'left' }}
            onClick={() => window.screencap.openExternal('https://console.cloud.google.com/apis/library/youtube.googleapis.com')}>
            ① Enable YouTube Data API v3 ↗
          </button>
          <button className="add" style={{ textAlign: 'left' }}
            onClick={() => window.screencap.openExternal('https://console.cloud.google.com/apis/credentials/consent')}>
            ② OAuth consent screen → add yourself as a test user ↗
          </button>
          <button className="add" style={{ textAlign: 'left' }}
            onClick={() => window.screencap.openExternal('https://console.cloud.google.com/apis/credentials')}>
            ③ Create credentials → OAuth client ID → Desktop app ↗
          </button>
          <small style={{ color: 'var(--dim)' }}>Then paste the client ID + secret from step ③:</small>
          <input className="add" style={{ textAlign: 'left' }} placeholder="Client ID"
            value={clientId} onChange={(e) => setClientId(e.target.value)} />
          <input className="add" style={{ textAlign: 'left' }} placeholder="Client secret" type="password"
            value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
          <button className="add" onClick={saveCreds} disabled={!clientId || !clientSecret}>Save & enable sign-in</button>
          {!status.encrypted && <small style={{ color: '#f59e0b' }}>⚠ OS secure storage unavailable — secrets stored unencrypted</small>}
        </div>
      )}

      {/* ---- signed in ---- */}
      {status.signedIn && (
        <>
          <div style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>✓ {status.channelTitle}</span>
            {!broadcast && <a style={{ cursor: 'pointer', color: 'var(--dim)' }} onClick={signOut}>sign out</a>}
          </div>

          {!broadcast && (
            <div style={{ display: 'grid', gap: 6 }}>
              <input className="add" style={{ textAlign: 'left' }} placeholder="Stream title"
                value={title} onChange={(e) => setTitle(e.target.value)} />
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)} style={{ flex: 1 }}>
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
                <select value={latency} onChange={(e) => setLatency(e.target.value as typeof latency)} style={{ flex: 1 }}>
                  <option value="normal">Normal latency</option>
                  <option value="low">Low latency</option>
                  <option value="ultraLow">Ultra-low latency</option>
                </select>
              </div>
              <button className="add" style={{ background: '#b91c1c', color: '#fff', fontWeight: 700 }}
                onClick={goLiveYouTube} disabled={!!busy}>
                {busy || '🔴 Go Live to YouTube'}
              </button>
              <small style={{ color: 'var(--dim)' }}>Stream key is fetched automatically — nothing to paste.</small>
            </div>
          )}

          {/* ---- live: chat + moderation ---- */}
          {broadcast && (
            <>
              <button className="add" style={{ background: '#374151', color: '#fff' }} onClick={endBroadcast}>
                ⏹ End broadcast
              </button>
              <div ref={chatRef} style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                {messages.length === 0 && <small style={{ color: 'var(--dim)' }}>Waiting for chat…</small>}
                {messages.map((m) => (
                  <div key={m.id} className="card" style={{ padding: 6 }}>
                    <div>
                      <b style={{ color: m.isOwner ? '#f59e0b' : m.isMod ? '#60a5fa' : '#e5e7eb' }}>
                        {m.isOwner ? '👑 ' : m.isMod ? '🛡 ' : ''}{m.authorName}
                      </b>
                      {m.isSuperChat && <span style={{ color: '#34d399' }}> · {m.amount}</span>}
                    </div>
                    <div style={{ wordBreak: 'break-word' }}>{m.text}</div>
                    {!m.isOwner && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 3, color: 'var(--dim)' }}>
                        <a style={{ cursor: 'pointer' }} title="Delete message" onClick={() => del(m)}>🗑</a>
                        <a style={{ cursor: 'pointer' }} title="Timeout 60s" onClick={() => timeout(m, 60)}>⏲60s</a>
                        <a style={{ cursor: 'pointer' }} title="Timeout 5m" onClick={() => timeout(m, 300)}>⏲5m</a>
                        <a style={{ cursor: 'pointer', color: '#f87171' }} title="Ban" onClick={() => ban(m)}>⛔ban</a>
                        <a style={{ cursor: 'pointer' }} title="Make moderator" onClick={() => mod(m)}>🛡mod</a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="add" style={{ textAlign: 'left', flex: 1 }} placeholder="Send a message…"
                  value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && send()} />
                <button className="add" style={{ width: 64 }} onClick={send}>Send</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
