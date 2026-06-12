/**
 * WebAudio mix bus: per-source gain + analyser strips into a master soft limiter, out to a
 * MediaStream destination for the recorder/streamer.
 */
export class Mixer {
  // 48kHz pinned: RNNoise (voice chain) only operates at 48k; Chromium resamples inputs.
  readonly ctx = new AudioContext({ sampleRate: 48000 });
  private dest = this.ctx.createMediaStreamDestination();
  private master = this.ctx.createDynamicsCompressor();
  private strips = new Map<string, { gain: GainNode; analyser: AnalyserNode; monitor: GainNode }>();

  constructor() {
    // Limiter-ish curve: high threshold, hard ratio, fast attack.
    this.master.threshold.value = -3;
    this.master.knee.value = 3;
    this.master.ratio.value = 20;
    this.master.attack.value = 0.002;
    this.master.release.value = 0.1;
    this.master.connect(this.dest);
  }

  get stream(): MediaStream {
    return this.dest.stream;
  }

  attach(id: string, node: AudioNode) {
    const gain = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    // Live monitoring tap (muted by default): the mix bus feeds recordings/streams; this
    // optional branch feeds the PC speakers so remote sources are audible in the room.
    const monitor = this.ctx.createGain();
    monitor.gain.value = 0;
    node.connect(gain);
    gain.connect(analyser);
    gain.connect(this.master);
    gain.connect(monitor);
    monitor.connect(this.ctx.destination);
    this.strips.set(id, { gain, analyser, monitor });
  }

  /** Route this strip to the speakers (careful with local mics — feedback). */
  setMonitor(id: string, on: boolean) {
    const s = this.strips.get(id);
    if (s) s.monitor.gain.value = on ? 1 : 0;
  }

  detach(id: string) {
    const s = this.strips.get(id);
    if (s) {
      s.gain.disconnect();
      s.analyser.disconnect();
      s.monitor.disconnect();
      this.strips.delete(id);
    }
  }

  setGain(id: string, value: number) {
    const s = this.strips.get(id);
    if (s) s.gain.gain.value = value;
  }

  /** Peak 0..1 for the strip's meter. */
  peak(id: string): number {
    const s = this.strips.get(id);
    if (!s) return 0;
    const buf = new Uint8Array(s.analyser.frequencyBinCount);
    s.analyser.getByteTimeDomainData(buf);
    let p = 0;
    for (const v of buf) p = Math.max(p, Math.abs(v - 128) / 128);
    return p;
  }
}
