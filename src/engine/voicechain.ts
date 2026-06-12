/**
 * Studio voice chain — the broadcast-standard channel strip, per mic source:
 *
 *   raw mic → HPF (rumble) → RNNoise (neural denoise, wet/dry with latency-matched dry leg)
 *           → ExpanderGate (ramped downward expander, floor −20dB — NEVER digital zero)
 *           → 4-band EQ (+ optional de-esser) → compressor + makeup → bus
 *
 * Panel-reviewed design (2026-06-12): single denoiser (stacked Speex deleted — Int16
 * round-trip + double RT-thread wasm cost for marginal gain); gate is a smooth expander
 * whose thresholds update via port messages so adjustments never rebuild the node or
 * rewire the live graph. RNNoise runs in an AudioWorklet at 48kHz (the Mixer pins its
 * context there). Assets arrive over IPC because fetch() can't load file:// URLs.
 */
import { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';

export interface VoiceFx {
  /** Pre-chain gain trim in dB — gain staging for hot/quiet capture levels. */
  inputDb: number;
  /** Chromium AEC on the capture track (local mics only) — kills speaker echo re-capture. */
  echoCancel: boolean;
  denoise: boolean;
  /** Wet/dry mix 0..1 — how much of the denoised signal replaces the raw one. */
  denoiseStrength: number;
  gate: boolean;
  /** Expander open threshold in dBFS; closes 14dB lower (wide hysteresis). */
  gateDb: number;
  /** High-pass corner frequency in Hz. */
  lowCut: number;
  /** Last chosen preset (UI convenience; the band fields are the truth). */
  preset: 'broadcast' | 'warm' | 'bright' | 'flat';
  /** Individual EQ bands in dB: low shelf 120Hz / peak 250Hz / peak 3kHz / high shelf 12kHz. */
  eqLow: number;
  eqMud: number;
  eqPresence: number;
  eqAir: number;
  deEss: boolean;
  /** De-esser cut depth in dB at 6.5kHz. */
  deEssDb: number;
  comp: boolean;
  /** Compression drive 0..1 — maps threshold -18→-35dB and ratio 2→6:1 together. */
  compAmount: number;
  makeupDb: number;
}

/** [low, mud, presence, air] in dB. */
export function presetBands(p: VoiceFx['preset']): [number, number, number, number] {
  switch (p) {
    case 'broadcast': return [1.5, -2.5, 3, 2];
    case 'warm': return [3, 1, 0, -1];
    case 'bright': return [-1, -3, 3.5, 4];
    default: return [0, 0, 0, 0];
  }
}

export const DEFAULT_FX: VoiceFx = {
  inputDb: 0,
  // OFF by default: AEC is an ADAPTIVE filter — it converges over ~seconds and, when its
  // model is wrong, progressively subtracts live speech. Headset users never need it.
  echoCancel: false,
  denoise: true,
  denoiseStrength: 1,
  gate: true,
  gateDb: -42,
  lowCut: 80,
  preset: 'broadcast',
  eqLow: 1.5,
  eqMud: -2.5,
  eqPresence: 3,
  eqAir: 2,
  deEss: false,
  deEssDb: 6,
  comp: true,
  compAmount: 0.35, // ≈ threshold -24dB, ratio 3.4:1
  makeupDb: 8,
};

/**
 * Ramped downward expander. Replaces the package's binary hard-mute gate (panel finding:
 * hard zero-mutes guillotine speech; an expander with a -20dB floor and 5/120ms ramps can
 * never produce a black bar). Thresholds via port messages — no node rebuild, no rewire.
 */
const EXPANDER_GATE_WORKLET = `
class ExpanderGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.open = Math.pow(10, -42 / 20);
    this.close = Math.pow(10, -56 / 20);
    this.floor = 0.1; // -20dB — never digital zero
    this.gain = 1;
    this.env = 0;
    this.opened = true;
    this.dead = false;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.openDb === 'number') this.open = Math.pow(10, d.openDb / 20);
      if (typeof d.closeDb === 'number') this.close = Math.pow(10, d.closeDb / 20);
      if (typeof d.floor === 'number') this.floor = d.floor;
      if (d.kill) this.dead = true;
    };
  }
  process(inputs, outputs) {
    if (this.dead) return false; // releases the RT-thread processor on source removal
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length || !inp[0]) return true;
    const attCoef = Math.exp(-1 / (0.005 * sampleRate)); // 5ms open ramp
    const relCoef = Math.exp(-1 / (0.120 * sampleRate)); // 120ms close ramp
    const envCoef = Math.exp(-1 / (0.010 * sampleRate)); // 10ms detector decay
    const ch0 = inp[0];
    for (let i = 0; i < ch0.length; i++) {
      const a = Math.abs(ch0[i]);
      this.env = a > this.env ? a : this.env * envCoef;
      if (this.env >= this.open) this.opened = true;
      else if (this.env < this.close) this.opened = false;
      const target = this.opened ? 1 : this.floor;
      const coef = target > this.gain ? attCoef : relCoef;
      this.gain = target + (this.gain - target) * coef;
      for (let c = 0; c < out.length; c++) {
        const ic = inp[c] || ch0;
        if (out[c]) out[c][i] = ic[i] * this.gain;
      }
    }
    return true;
  }
}
registerProcessor('expander-gate', ExpanderGate);
`;

// ---- one-time worklet/wasm bootstrap (shared across all chains on the mixer ctx) ----
type Bootstrap = { wasm: ArrayBuffer | null; gateOk: boolean };
let bootstrap: Promise<Bootstrap> | null = null;

function ensureWorklets(ctx: AudioContext): Promise<Bootstrap> {
  if (!bootstrap) {
    bootstrap = (async () => {
      const mod = (code: string) =>
        ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      // The gate is pure inline JS — it must survive an RNNoise asset failure.
      let gateOk = false;
      try {
        await mod(EXPANDER_GATE_WORKLET);
        gateOk = true;
      } catch (e) {
        console.error('[voicefx] expander-gate registration failed:', e);
      }
      let wasm: ArrayBuffer | null = null;
      try {
        const a = await window.screencap.voiceFxAssets();
        if (!a || a.error) throw new Error(a?.error ?? 'no assets');
        await mod(a.rnnoiseWorklet);
        const u8 = new Uint8Array(a.rnnoiseWasm);
        wasm = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        console.log(`[voicefx] worklets ready — RNNoise + expander-gate, ctx ${ctx.sampleRate}Hz`);
      } catch (e) {
        console.error('[voicefx] RNNoise bootstrap failed — denoise disabled:', e);
      }
      return { wasm, gateOk };
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
  // Denoise wet/dry mix; dry leg delayed to match RNNoise's 480-sample framing latency
  // (without it, mixing wet+dry comb-filters the voice).
  private dnWet: GainNode;
  private dnDry: GainNode;
  private dnDelay: DelayNode;
  private dnSum: GainNode;
  private rnnoise: RnnoiseWorkletNode | null = null;
  private gateNode: AudioWorkletNode | null = null;
  private wasm: ArrayBuffer | null = null;
  private fx: VoiceFx;
  private topology = '';

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
    this.hs = biquad('highshelf', 12000);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 6;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.15;
    this.makeup = ctx.createGain();
    this.dnWet = ctx.createGain();
    this.dnDry = ctx.createGain();
    this.dnDelay = new DelayNode(ctx, { delayTime: 0.010, maxDelayTime: 0.05 });
    this.dnSum = ctx.createGain();
  }

  async init(): Promise<void> {
    const boot = await ensureWorklets(this.ctx);
    this.wasm = boot.wasm;
    if (this.wasm && this.ctx.sampleRate === 48000) {
      this.rnnoise = new RnnoiseWorkletNode(this.ctx, { maxChannels: 2, wasmBinary: this.wasm });
    }
    if (boot.gateOk) {
      this.gateNode = new AudioWorkletNode(this.ctx, 'expander-gate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
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
    // ---- parameter-only updates (live-safe, no graph interruption) ----
    this.input.gain.value = Math.pow(10, fx.inputDb / 20);
    this.hpf.frequency.value = fx.lowCut;
    this.ls.gain.value = fx.eqLow;
    this.p1.gain.value = fx.eqMud;
    this.p2.gain.value = fx.eqPresence;
    this.hs.gain.value = fx.eqAir;
    this.deEssF.gain.value = -Math.abs(fx.deEssDb);
    this.dnWet.gain.value = fx.denoiseStrength;
    this.dnDry.gain.value = 1 - fx.denoiseStrength;
    this.comp.threshold.value = -18 - 17 * fx.compAmount; // 0→-18dB … 1→-35dB
    this.comp.ratio.value = 2 + 4 * fx.compAmount; //         0→2:1  … 1→6:1
    this.makeup.gain.value = Math.pow(10, fx.makeupDb / 20);
    // Expander thresholds ride port messages — never a rebuild, never a rewire.
    this.gateNode?.port.postMessage({ openDb: fx.gateDb, closeDb: fx.gateDb - 14 });
    // Only tear down / reconnect the live path when its SHAPE changes.
    const topology = [
      fx.denoise && !!this.rnnoise, fx.gate && !!this.gateNode, fx.deEss, fx.comp,
    ].join(',');
    if (topology !== this.topology) {
      this.topology = topology;
      this.wire();
    }
  }

  private wire() {
    // NEVER disconnect this.output: its outgoing edge is the App-owned chain→mixer
    // connection. disconnect() only cuts OUTGOING edges, so dropping upstream nodes'
    // edges fully resets the internal chain.
    const nodes: (AudioNode | null)[] = [
      this.input, this.hpf, this.rnnoise, this.gateNode, this.ls, this.p1, this.p2,
      this.deEssF, this.hs, this.comp, this.makeup, this.dnWet, this.dnDry, this.dnDelay, this.dnSum,
    ];
    for (const n of nodes) { try { n?.disconnect(); } catch {} }
    let prev: AudioNode = this.input;
    prev.connect(this.hpf);
    prev = this.hpf;
    if (this.fx.denoise && this.rnnoise) {
      // Wet/dry mix: strength crossfades denoised vs raw; dry leg delay-matched.
      prev.connect(this.rnnoise);
      this.rnnoise.connect(this.dnWet);
      prev.connect(this.dnDelay);
      this.dnDelay.connect(this.dnDry);
      this.dnWet.connect(this.dnSum);
      this.dnDry.connect(this.dnSum);
      prev = this.dnSum;
    }
    if (this.fx.gate && this.gateNode) {
      prev.connect(this.gateNode);
      prev = this.gateNode;
    }
    prev.connect(this.ls);
    this.ls.connect(this.p1);
    this.p1.connect(this.p2);
    prev = this.p2;
    if (this.fx.deEss) {
      prev.connect(this.deEssF);
      prev = this.deEssF;
    }
    prev.connect(this.hs);
    prev = this.hs;
    if (this.fx.comp) {
      prev.connect(this.comp);
      this.comp.connect(this.makeup);
      prev = this.makeup;
    }
    prev.connect(this.output);
  }

  dispose() {
    try { this.input.disconnect(); } catch {}
    try { this.output.disconnect(); } catch {}
    try { this.rnnoise?.destroy(); } catch {}
    try { this.gateNode?.port.postMessage({ kill: true }); } catch {} // RT-thread processor release
    try { this.gateNode?.disconnect(); } catch {}
  }
}
