/**
 * Studio voice chain — the broadcast-standard channel strip, per mic source:
 *
 *   raw mic → HPF (rumble) → RNNoise (neural denoise, same model OBS ships)
 *           → noise gate → 4-band EQ (+ optional de-esser) → compressor + makeup → bus
 *
 * RNNoise runs in an AudioWorklet at 48kHz (the Mixer pins its context there).
 * Assets (worklet JS + wasm) arrive over IPC because fetch() can't load file:// URLs.
 */
import { NoiseGateWorkletNode, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';

export interface VoiceFx {
  enabled: boolean;
  /** Chromium AEC on the capture track (local mics only) — kills speaker echo re-capture. */
  echoCancel: boolean;
  denoise: boolean;
  gate: boolean;
  /** Gate open threshold in dBFS; closes 5dB lower. */
  gateDb: number;
  /** High-pass corner frequency in Hz. */
  lowCut: number;
  preset: 'broadcast' | 'warm' | 'bright' | 'flat';
  deEss: boolean;
  comp: boolean;
  makeupDb: number;
}

export const DEFAULT_FX: VoiceFx = {
  enabled: true,
  echoCancel: true,
  denoise: true,
  gate: true,
  gateDb: -45,
  lowCut: 80,
  preset: 'broadcast',
  deEss: false,
  comp: true,
  makeupDb: 4,
};

/** [low-shelf 120Hz, peak 250Hz (mud), peak 3kHz (presence), high-shelf 12kHz (air)] in dB. */
const EQ_PRESETS: Record<VoiceFx['preset'], [number, number, number, number]> = {
  flat: [0, 0, 0, 0],
  broadcast: [1.5, -2.5, 3, 2],
  warm: [3, 1, 0, -1],
  bright: [-1, -3, 3.5, 4],
};

// ---- one-time worklet/wasm bootstrap (shared across all chains on the mixer ctx) ----
let bootstrap: Promise<ArrayBuffer | null> | null = null;

function ensureWorklets(ctx: AudioContext): Promise<ArrayBuffer | null> {
  if (!bootstrap) {
    bootstrap = (async () => {
      try {
        const a = await window.screencap.voiceFxAssets();
        if (!a || a.error) throw new Error(a?.error ?? 'no assets');
        const mod = (code: string) =>
          ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
        await mod(a.rnnoiseWorklet);
        await mod(a.gateWorklet);
        const u8 = new Uint8Array(a.rnnoiseWasm);
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      } catch (e) {
        console.warn('[voicefx] worklet bootstrap failed — denoise/gate disabled:', e);
        return null;
      }
    })();
  }
  return bootstrap;
}

export class VoiceChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private hpf: BiquadFilterNode;
  private ls: BiquadFilterNode;
  private p1: BiquadFilterNode;
  private p2: BiquadFilterNode;
  private deEssF: BiquadFilterNode;
  private hs: BiquadFilterNode;
  private comp: DynamicsCompressorNode;
  private makeup: GainNode;
  private rnnoise: RnnoiseWorkletNode | null = null;
  private gateNode: NoiseGateWorkletNode | null = null;
  private gateBuiltAtDb = NaN;
  private wasm: ArrayBuffer | null = null;
  private fx: VoiceFx;

  constructor(private ctx: AudioContext, initial?: VoiceFx) {
    this.fx = { ...(initial ?? DEFAULT_FX) };
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const biquad = (type: BiquadFilterType, freq: number, q = 1) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = freq;
      b.Q.value = q;
      return b;
    };
    this.hpf = biquad('highpass', this.fx.lowCut, 0.707);
    this.ls = biquad('lowshelf', 120);
    this.p1 = biquad('peaking', 250, 1);
    this.p2 = biquad('peaking', 3000, 1);
    this.deEssF = biquad('peaking', 6500, 2.5);
    this.deEssF.gain.value = -6;
    this.hs = biquad('highshelf', 12000);
    // Voice compressor: gentle 3.5:1, fast-ish attack, musical release.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -28;
    this.comp.knee.value = 10;
    this.comp.ratio.value = 3.5;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.18;
    this.makeup = ctx.createGain();
  }

  async init(): Promise<void> {
    this.wasm = await ensureWorklets(this.ctx);
    if (this.wasm && this.ctx.sampleRate === 48000) {
      this.rnnoise = new RnnoiseWorkletNode(this.ctx, { maxChannels: 2, wasmBinary: this.wasm });
    }
    this.apply(this.fx);
  }

  get settings(): VoiceFx {
    return { ...this.fx };
  }

  /** RNNoise availability (worklet bootstrapped + 48kHz context). */
  get denoiseAvailable(): boolean {
    return this.rnnoise !== null;
  }

  apply(fx: VoiceFx) {
    this.fx = { ...fx };
    this.hpf.frequency.value = fx.lowCut;
    const [lsDb, p1Db, p2Db, hsDb] = EQ_PRESETS[fx.preset];
    this.ls.gain.value = lsDb;
    this.p1.gain.value = p1Db;
    this.p2.gain.value = p2Db;
    this.hs.gain.value = hsDb;
    this.makeup.gain.value = Math.pow(10, fx.makeupDb / 20);
    // Gate thresholds are construction-time options — rebuild when the slider moves.
    if (fx.gate && this.wasm && this.gateBuiltAtDb !== fx.gateDb) {
      try { this.gateNode?.disconnect(); } catch {}
      this.gateNode = new NoiseGateWorkletNode(this.ctx, {
        openThreshold: fx.gateDb,
        closeThreshold: fx.gateDb - 5,
        holdMs: 150,
        maxChannels: 2,
      });
      this.gateBuiltAtDb = fx.gateDb;
    }
    this.wire();
  }

  private wire() {
    const nodes: (AudioNode | null)[] = [
      this.input, this.hpf, this.rnnoise, this.gateNode, this.ls, this.p1, this.p2,
      this.deEssF, this.hs, this.comp, this.makeup, this.output,
    ];
    for (const n of nodes) { try { n?.disconnect(); } catch {} }
    const chain: AudioNode[] = [this.input];
    if (this.fx.enabled) {
      chain.push(this.hpf);
      if (this.fx.denoise && this.rnnoise) chain.push(this.rnnoise);
      if (this.fx.gate && this.gateNode) chain.push(this.gateNode);
      chain.push(this.ls, this.p1, this.p2);
      if (this.fx.deEss) chain.push(this.deEssF);
      chain.push(this.hs);
      if (this.fx.comp) chain.push(this.comp, this.makeup);
    }
    chain.push(this.output);
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
  }

  dispose() {
    try { this.input.disconnect(); } catch {}
    try { this.output.disconnect(); } catch {}
    try { this.rnnoise?.destroy(); } catch {}
    try { this.gateNode?.disconnect(); } catch {}
  }
}
