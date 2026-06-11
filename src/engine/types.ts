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
  readonly video: HTMLVideoElement | null;
  readonly audioNode: AudioNode | null;
  start(): Promise<void>;
  stop(): void;
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
    };
  }
}
