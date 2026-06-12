import type { Source, SourceKind } from './types';

let nextId = 1;
const genId = (k: string) => `${k}-${nextId++}`;

function makeVideo(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement('video');
  v.srcObject = stream;
  v.muted = true;
  void v.play();
  return v;
}

abstract class BaseSource implements Source {
  readonly id: string;
  video: HTMLVideoElement | null = null;
  audioNode: AudioNode | null = null;
  rotation = 0;
  protected stream: MediaStream | null = null;
  constructor(
    readonly kind: SourceKind,
    readonly label: string,
    protected audioCtx: AudioContext,
  ) {
    this.id = genId(kind);
  }
  abstract start(): Promise<void>;
  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this.audioNode?.disconnect();
    this.audioNode = null;
  }
}

/** A display OR a single window, with Windows loopback system audio for displays. */
export class ScreenSource extends BaseSource {
  constructor(
    audioCtx: AudioContext,
    private captureId: string,
    label: string,
    private withSystemAudio: boolean,
  ) {
    super('screen', label, audioCtx);
  }

  async start(): Promise<void> {
    const constraints: MediaStreamConstraints = {
      video: {
        // Electron's desktop capture path: select the exact display/window by id.
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: this.captureId,
          maxFrameRate: 30,
        },
      } as MediaTrackConstraints,
      audio: this.withSystemAudio
        ? ({ mandatory: { chromeMediaSource: 'desktop' } } as MediaTrackConstraints)
        : false,
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video = makeVideo(this.stream);
    const at = this.stream.getAudioTracks();
    if (at.length) {
      this.audioNode = this.audioCtx.createMediaStreamSource(new MediaStream([at[0]]));
    }
  }
}

export class WebcamSource extends BaseSource {
  constructor(audioCtx: AudioContext, private deviceId: string | undefined, label: string) {
    super('webcam', label, audioCtx);
  }
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
        width: 1280,
        height: 720,
      },
    });
    this.video = makeVideo(this.stream);
  }
}

export class MicSource extends BaseSource {
  constructor(audioCtx: AudioContext, private deviceId: string | undefined, label: string) {
    super('mic', label, audioCtx);
  }
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
        // AEC ON by default (speaker setups re-capture their own output as echo);
        // NS/AGC OFF — the studio voice chain (HPF→RNNoise→gate→EQ→comp) does that
        // processing, and browser DSP on top causes the "underwater webinar" sound.
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.audioNode = this.audioCtx.createMediaStreamSource(this.stream);
  }

  /** Live AEC flip — no restart; Chromium applies it on the running track. */
  async setEchoCancellation(on: boolean): Promise<void> {
    const t = this.stream?.getAudioTracks()[0];
    if (t) {
      await t.applyConstraints({
        echoCancellation: on,
        noiseSuppression: false,
        autoGainControl: false,
      });
    }
  }
}
