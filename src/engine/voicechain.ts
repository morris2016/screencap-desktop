/**
 * Studio voice chain — the broadcast-standard channel strip, per mic source:
 *
 *   raw mic → HPF (rumble) → RNNoise (neural denoise, wet/dry strength)
 *           → noise gate → 4-band EQ (+ optional de-esser) → compressor + makeup → bus
 *
 * Every stage is individually switchable and adjustable. RNNoise runs in an AudioWorklet
 * at 48kHz (the Mixer pins its context there). Assets (worklet JS + wasm) arrive over IPC
 * because fetch() can't load file:// URLs.
 */
import { NoiseGateWorkletNode, RnnoiseWorkletNode, SpeexWorkletNode } from '@sapphi-red/web-noise-suppressor';

export interface VoiceFx {
  /** Pre-chain gain trim in dB — gain staging for hot/quiet capture levels. */
  inputDb: number;
  /** Chromium AEC on the capture track (local mics only) — kills speaker echo re-capture. */
  echoCancel: boolean;
  denoise: boolean;
  /** Second-stage spectral denoiser (Speex) — catches steady hiss RNNoise lets through. */
  deepDenoise: boolean;
  /** Wet/dry mix 0..1 — how much of the denoised signal replaces the raw one. */
  denoiseStrength: number;
  gate: boolean;
  /** Gate open threshold in dBFS; closes 5dB lower. */
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
  // model is wrong, progressively subtracts live speech (field evidence: VOD clean for the
  // first seconds of talking, then hard chop slices). Only useful when speakers play sound
  // the mic can hear; headset users never need it.
  echoCancel: false,
  denoise: true,
  deepDenoise: true,
  denoiseStrength: 1,
  gate: true,
  gateDb: -45,
  lowCut: 80,
  preset: 'broadcast',
  eqLow: 1.5,
  eqMud: -2.5,
  eqPresence: 3,
  eqAir: 2,
  deEss: false,
  deEssDb: 6,
  comp: true,
  compAmount: 0.6,
  makeupDb: 4,
};

// ---- one-time worklet/wasm bootstrap (shared across all chains on the mixer ctx) ----
type FxWasm = { rnnoise: ArrayBuffer; speex: ArrayBuffer };
let bootstrap: Promise<FxWasm | null> | null = null;

function ensureWorklets(ctx: AudioContext): Promise<FxWasm | null> {
  if (!bootstrap) {
    bootstrap = (async () => {
      try {
        const a = await window.screencap.voiceFxAssets();
        if (!a || a.error) throw new Error(a?.error ?? 'no assets');
        const mod = (code: string) =>
          ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
        await mod(a.rnnoiseWorklet);
        await mod(a.gateWorklet);
        await mod(a.speexWorklet);
        const toBuf = (u8raw: Uint8Array) => {
          const u8 = new Uint8Array(u8raw);
          return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        };
        console.log(`[voicefx] worklets ready — RNNoise+Speex+gate, ctx ${ctx.sampleRate}Hz`);
        return { rnnoise: toBuf(a.rnnoiseWasm), speex: toBuf(a.speexWasm) };
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
  // Denoise wet/dry mix
  private dnWet: GainNode;
  private dnDry: GainNode;
  private dnSum: GainNode;
  private rnnoise: RnnoiseWorkletNode | null = null;
  private speex: SpeexWorkletNode | null = null;
  private gateNode: NoiseGateWorkletNode | null = null;
  private gateBuiltAtDb = NaN;
  private wasm: FxWasm | null = null;
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
    this.comp.knee.value = 10;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.18;
    this.makeup = ctx.createGain();
    this.dnWet = ctx.createGain();
    this.dnDry = ctx.createGain();
    this.dnSum = ctx.createGain();
  }

  async init(): Promise<void> {
    this.wasm = await ensureWorklets(this.ctx);
    if (this.wasm && this.ctx.sampleRate === 48000) {
      this.rnnoise = new RnnoiseWorkletNode(this.ctx, { maxChannels: 2, wasmBinary: this.wasm.rnnoise });
      this.speex = new SpeexWorkletNode(this.ctx, { maxChannels: 2, wasmBinary: this.wasm.speex });
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
    // ---- gate thresholds are construction-time options — rebuild when committed ----
    let gateRebuilt = false;
    if (fx.gate && this.wasm && this.gateBuiltAtDb !== fx.gateDb) {
      try { this.gateNode?.disconnect(); } catch {}
      // Wide hysteresis + long hold: a tight gate guillotines quiet syllable tails
      // (field evidence: hard 50-200ms mute slices through speech on the YT VOD).
      this.gateNode = new NoiseGateWorkletNode(this.ctx, {
        openThreshold: fx.gateDb,
        closeThreshold: fx.gateDb - 12,
        holdMs: 400,
        maxChannels: 2,
      });
      this.gateBuiltAtDb = fx.gateDb;
      gateRebuilt = true;
    }
    // Only tear down / reconnect the live path when its SHAPE changes — rewiring on
    // every param tweak interrupts the graph audibly.
    const topology = [
      fx.denoise && !!this.rnnoise, fx.deepDenoise && !!this.speex,
      fx.gate && !!this.gateNode, fx.deEss, fx.comp,
    ].join(',');
    if (topology !== this.topology || gateRebuilt) {
      this.topology = topology;
      this.wire();
    }
  }

  private wire() {
    // NEVER disconnect this.output: its outgoing edge is the App-owned chain→mixer
    // connection. disconnect() only cuts OUTGOING edges, so dropping upstream nodes'
    // edges fully resets the internal chain.
    const nodes: (AudioNode | null)[] = [
      this.input, this.hpf, this.rnnoise, this.speex, this.gateNode, this.ls, this.p1, this.p2,
      this.deEssF, this.hs, this.comp, this.makeup, this.dnWet, this.dnDry, this.dnSum,
    ];
    for (const n of nodes) { try { n?.disconnect(); } catch {} }
    let prev: AudioNode = this.input;
    prev.connect(this.hpf);
    prev = this.hpf;
    if (this.fx.denoise && this.rnnoise) {
      // Wet/dry mix: strength crossfades between denoised and raw.
      prev.connect(this.rnnoise);
      this.rnnoise.connect(this.dnWet);
      prev.connect(this.dnDry);
      this.dnWet.connect(this.dnSum);
      this.dnDry.connect(this.dnSum);
      prev = this.dnSum;
    }
    if (this.fx.deepDenoise && this.speex) {
      // Spectral pass after the neural one — mops up steady hiss RNNoise leaves.
      prev.connect(this.speex);
      prev = this.speex;
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
    try { this.speex?.destroy(); } catch {}
    try { this.gateNode?.disconnect(); } catch {}
  }
}
