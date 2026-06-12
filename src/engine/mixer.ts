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

  /**
   * Engine health watchdog (panel spec 2026-06-12): a heartbeat worklet counts render
   * quanta; rendered-time vs wall-clock deficit >2% = the renderer is being starved
   * (the live-audio-chop class of bug). Also watches for AudioContext death (3 field
   * occurrences of WASAPI context errors) and attempts resume. Alerts surface in the UI.
   */
  async startWatchdog(onAlert: (msg: string | null) => void): Promise<void> {
    try {
      const HEARTBEAT = `
        class Heartbeat extends AudioWorkletProcessor {
          constructor() { super(); this.n = 0; }
          process() {
            this.n++;
            if (this.n % 94 === 0) this.port.postMessage(this.n); // ~every 250ms at 48k
            return true;
          }
        }
        registerProcessor('heartbeat', Heartbeat);
      `;
      await this.ctx.audioWorklet.addModule(
        URL.createObjectURL(new Blob([HEARTBEAT], { type: 'text/javascript' })),
      );
      const hb = new AudioWorkletNode(this.ctx, 'heartbeat', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const sink = this.ctx.createGain();
      sink.gain.value = 0; // silent — the worklet just needs to be pulled by the graph
      hb.connect(sink);
      sink.connect(this.ctx.destination);
      let quanta = 0;
      hb.port.onmessage = (e) => { quanta = e.data as number; };
      // Cumulative-deficit detector: the worklet posts every ~250ms, so per-window deltas
      // are quantized far coarser than a percent threshold (review finding: a naive 2%
      // check false-alarms every ~90s). Instead track total rendered vs total wall time
      // and alert only when the deficit GROWS >350ms within a 2s window — real throttling
      // starves 30-55%, quantization error stays bounded at ~251ms.
      const startWall = performance.now();
      let prevDeficit = 0;
      setInterval(() => {
        if (this.ctx.state !== 'running') {
          // Re-assert the alert every tick (a one-shot onstatechange banner gets wiped)
          // and keep retrying resume — WASAPI device loss recovers when the device returns.
          console.error(`[audio-watchdog] AudioContext state=${this.ctx.state} — retrying resume`);
          onAlert(`⚠ AUDIO ENGINE ${this.ctx.state.toUpperCase()} — attempting recovery`);
          void this.ctx.resume().catch(() => {});
          prevDeficit = performance.now() - startWall - ((quanta * 128) / this.ctx.sampleRate) * 1000;
          return;
        }
        const renderedMs = ((quanta * 128) / this.ctx.sampleRate) * 1000;
        const deficit = performance.now() - startWall - renderedMs;
        const growth = deficit - prevDeficit;
        prevDeficit = deficit;
        if (growth > 350) {
          const pct = Math.round((growth / 2000) * 100);
          console.error(`[audio-watchdog] STARVED: engine lost ${Math.round(growth)}ms in the last 2s (~${pct}%)`);
          onAlert(`⚠ AUDIO ENGINE STARVED (~${pct}% loss) — recordings/streams are losing audio right now`);
        } else {
          onAlert(null);
        }
      }, 2000);
      this.ctx.onstatechange = () => {
        if (this.ctx.state !== 'running') {
          console.error(`[audio-watchdog] AudioContext state=${this.ctx.state} — attempting resume`);
          onAlert(`⚠ AUDIO ENGINE ${this.ctx.state.toUpperCase()} — attempting recovery`);
          void this.ctx.resume().catch(() => {});
        }
      };
    } catch (e) {
      console.error('[audio-watchdog] init failed:', e);
    }
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
