export type SourceKind = 'screen' | 'webcam' | 'mic' | 'phone-cam';

export interface CaptureSourceInfo {
  id: string;
  name: string;
  isScreen: boolean;
  thumbnail: string;
}

/** A live input. Video sources expose a drawable element; audio sources a WebAudio node. */
export interface Source {
  readonly id: string;
  readonly kind: SourceKind;
  readonly label: string;
  readonly video: HTMLVideoElement | HTMLCanvasElement | null;
  readonly audioNode: AudioNode | null;
  /** Display rotation in degrees (0/90/180/270) — e.g. portrait-held phone cameras. */
  rotation: number;
  start(): Promise<void>;
  stop(): void;
}

export interface LinkInfo {
  port: number;
  code: string | null;
  ips: string[];
  phoneConnected: boolean;
}

/** One source placed in a scene, in canvas-normalized coordinates (0..1). */
export interface SceneItem {
  sourceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Rounded-corner + border accent (used for facecam bubbles). */
  accent?: boolean;
}

export interface Scene {
  id: string;
  name: string;
  hotkey?: string;
  items: SceneItem[];
}

// ---- YouTube Live integration ----
export type YtResult<T> = { ok: true; data: T } | { ok: false; error: string; reason: string | null };
export interface YtStatus {
  hasCreds: boolean;
  signedIn: boolean;
  channelTitle: string | null;
  channelId: string | null;
  encrypted: boolean;
}
export interface YtBroadcast {
  id: string;
  title: string;
  privacy: string;
  lifeCycle: string;
  liveChatId: string;
  scheduledStartTime: string;
}
export interface YtStreamInfo {
  streamId: string;
  ingestionAddress: string;
  streamName: string;
}
export interface YtChatMessage {
  id: string;
  authorName: string;
  authorChannelId: string;
  text: string;
  isMod: boolean;
  isOwner: boolean;
  isSuperChat: boolean;
  amount: string | null;
  publishedAt: string;
}
export interface YtCreateOpts {
  title: string;
  description?: string;
  privacy: 'public' | 'unlisted' | 'private';
  scheduledStartTime?: string;
  latency?: 'normal' | 'low' | 'ultraLow';
}
export interface YouTubeBridge {
  status(): Promise<YtResult<YtStatus>>;
  setCredentials(id: string, secret: string): Promise<YtResult<YtStatus>>;
  signIn(): Promise<YtResult<YtStatus>>;
  signOut(): Promise<YtResult<YtStatus>>;
  listBroadcasts(): Promise<YtResult<YtBroadcast[]>>;
  createBroadcast(opts: YtCreateOpts): Promise<YtResult<{ id: string; liveChatId: string; title: string }>>;
  prepareStream(broadcastId: string): Promise<YtResult<YtStreamInfo>>;
  prepareLive(opts: YtCreateOpts): Promise<YtResult<YtStreamInfo & { broadcastId: string; liveChatId: string }>>;
  streamHealth(streamId: string): Promise<YtResult<string>>;
  broadcastStatus(broadcastId: string): Promise<YtResult<{ lifeCycleStatus?: string; streamStatus?: string }>>;
  transition(broadcastId: string, status: 'testing' | 'live' | 'complete'): Promise<YtResult<unknown>>;
  setThumbnail(broadcastId: string, filePath: string): Promise<YtResult<unknown>>;
  chatStart(liveChatId: string): void;
  chatStop(): void;
  chatSend(liveChatId: string, text: string): Promise<YtResult<unknown>>;
  chatDelete(messageId: string): Promise<YtResult<unknown>>;
  chatBan(liveChatId: string, channelId: string, seconds: number | null): Promise<YtResult<unknown>>;
  chatAddMod(liveChatId: string, channelId: string): Promise<YtResult<unknown>>;
  onChatMessages(cb: (msgs: YtChatMessage[]) => void): void;
}

/** Native-audio capture options for the fully-native (ffmpeg) pipeline. */
export interface NativeAudioOpts {
  /** Capture system audio (WASAPI loopback) and mix it with the mic. */
  system: boolean;
  /** System-audio level trim in dB. */
  sysGainDb?: number;
}

declare global {
  interface Window {
    screencap: {
      getCaptureSources(): Promise<CaptureSourceInfo[]>;
      saveRecording(buf: ArrayBuffer, name: string): Promise<string | null>;
      saveScreenshot(dataUrl: string): Promise<string | null>;
      linkStart(): Promise<LinkInfo>;
      linkInfo(): Promise<LinkInfo>;
      onLinkStatus(cb: (s: { phone: string }) => void): void;
      finalizeRecording(buf: ArrayBuffer, h264: boolean): Promise<string | null>;
      libraryList(): Promise<Array<{ name: string; path: string; size: number; mtime: number }>>;
      libraryOpen(p: string): Promise<void>;
      libraryOpenFolder(): Promise<void>;
      libraryDelete(p: string): Promise<boolean>;
      streamStart(
        url: string,
        key: string,
        bitrateK: number,
        direct: boolean,
        micDevice: string | null,
        fx: unknown,
        audio: NativeAudioOpts,
      ): Promise<{ ok: boolean; error?: string }>;
      streamChunk(chunk: ArrayBuffer): void;
      streamStop(): Promise<boolean>;
      onStreamEnded(cb: (code: number, reason?: string) => void): void;
      onStreamHealth(cb: (h: { fps: number; kbps: number; speed: number; attempts: number }) => void): void;
      onStreamRestarting(cb: (attempt: number, reason: string, delayMs: number) => void): void;
      onStreamResume(cb: () => void): void;
      voiceFxAssets(): Promise<{ rnnoiseWorklet: string; rnnoiseWasm: Uint8Array; error?: string }>;
      sessionActive(on: boolean): void;
      openExternal(url: string): Promise<void>;
      nativeRecordStart(micDevice: string | null, fx: unknown, audio: NativeAudioOpts): Promise<{ ok: boolean; error?: string }>;
      nativeRecordStop(): Promise<string | null>;
      onNativeRecordFailed(cb: () => void): void;
      yt: YouTubeBridge;
    };
  }
}
