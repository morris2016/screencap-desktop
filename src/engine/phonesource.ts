import type { Source } from './types';

/**
 * The first-party Phone Link source: consumes the LinkServer relay as a local viewer.
 * VIDEO: Annex-B H.264 (SPS/PPS prepended to keyframes by the phone) → WebCodecs VideoDecoder
 *        (no description = Annex-B mode) → latest frame painted onto an offscreen canvas the
 *        compositor draws like any video.
 * AUDIO: 48k mono PCM16 frames → jitter-buffered AudioBufferSource scheduling into the mixer.
 * CONTROL: JSON text back to the phone (switch camera, torch, quality).
 */
export class PhoneSource implements Source {
  readonly id: string;
  readonly kind = 'phone-cam' as const;
  label = 'Phone camera';
  video: HTMLCanvasElement | null = null;
  audioNode: AudioNode | null = null;

  private ws: WebSocket | null = null;
  private decoder: VideoDecoder | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private audioGain: GainNode;
  private nextAudioTime = 0;
  private statsCb: ((s: Record<string, unknown>) => void) | null = null;
  private decodedFrames = 0;

  constructor(private audioCtx: AudioContext, private port: number, private code: string) {
    this.id = `phone-${Date.now()}`;
    this.audioGain = audioCtx.createGain();
    this.audioNode = this.audioGain;
  }

  onStats(cb: (s: Record<string, unknown>) => void) {
    this.statsCb = cb;
  }

  /** fps actually decoded since the last call (UI HUD). */
  takeDecodedFps(intervalMs: number): number {
    const fps = (this.decodedFrames * 1000) / intervalMs;
    this.decodedFrames = 0;
    return Math.round(fps);
  }

  sendControl(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async start(): Promise<void> {
    this.video = document.createElement('canvas');
    this.video.width = 720;
    this.video.height = 1280;
    this.ctx2d = this.video.getContext('2d')!;

    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/?role=viewer&code=${this.code}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (ev) => this.onFrame(ev.data as ArrayBuffer);
  }

  private ensureDecoder() {
    if (this.decoder && this.decoder.state === 'configured') return;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const c = this.video!;
        if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
          c.width = frame.displayWidth;
          c.height = frame.displayHeight;
        }
        this.ctx2d!.drawImage(frame, 0, 0);
        frame.close();
        this.decodedFrames++;
      },
      error: () => {
        // Decoder fault: rebuild on the next keyframe.
        this.decoder = null;
      },
    });
    // No description => Annex-B mode; SPS/PPS arrive in-band before each keyframe.
    this.decoder.configure({ codec: 'avc1.42E01F', optimizeForLatency: true });
  }

  private onFrame(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    const type = dv.getUint8(0);
    const flags = dv.getUint8(1);
    const ptsUs = Number(dv.getBigUint64(2));
    const len = dv.getUint32(10);
    const payload = new Uint8Array(buf, 14, len);

    if (type === 1) {
      // VIDEO
      const key = (flags & 1) !== 0;
      this.ensureDecoder();
      if (!this.decoder) return;
      if (this.decoder.decodeQueueSize > 8) return; // never let the queue snowball (latency)
      try {
        this.decoder.decode(
          new EncodedVideoChunk({
            type: key ? 'key' : 'delta',
            timestamp: ptsUs,
            data: payload,
          }),
        );
      } catch {
        this.decoder = null;
      }
    } else if (type === 2) {
      // AUDIO: PCM16 mono 48k → schedule.
      const samples = new Int16Array(payload.buffer, payload.byteOffset, len / 2);
      const ab = this.audioCtx.createBuffer(1, samples.length, 48_000);
      const ch = ab.getChannelData(0);
      for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
      const src = this.audioCtx.createBufferSource();
      src.buffer = ab;
      src.connect(this.audioGain);
      const now = this.audioCtx.currentTime;
      // 80ms jitter buffer; resync if we fell behind.
      if (this.nextAudioTime < now + 0.02) this.nextAudioTime = now + 0.08;
      src.start(this.nextAudioTime);
      this.nextAudioTime += ab.duration;
    } else if (type === 3) {
      // STATS heartbeat (JSON payload)
      try {
        this.statsCb?.(JSON.parse(new TextDecoder().decode(payload)));
      } catch {}
    }
  }

  stop(): void {
    this.ws?.close();
    this.ws = null;
    try {
      this.decoder?.close();
    } catch {}
    this.decoder = null;
    this.audioGain.disconnect();
  }
}
