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
      ): Promise<{ ok: boolean; error?: string }>;
      streamChunk(chunk: ArrayBuffer): void;
      streamStop(): Promise<boolean>;
      onStreamEnded(cb: (code: number, reason?: string) => void): void;
      onStreamHealth(cb: (h: { fps: number; kbps: number; speed: number; attempts: number }) => void): void;
      onStreamRestarting(cb: (attempt: number, reason: string, delayMs: number) => void): void;
      onStreamResume(cb: () => void): void;
      voiceFxAssets(): Promise<{ rnnoiseWorklet: string; rnnoiseWasm: Uint8Array; error?: string }>;
      sessionActive(on: boolean): void;
      nativeRecordStart(micDevice: string | null, fx: unknown): Promise<{ ok: boolean; error?: string }>;
      nativeRecordStop(): Promise<string | null>;
      onNativeRecordFailed(cb: () => void): void;
    };
  }
}
