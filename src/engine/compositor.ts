import type { Scene, SceneItem, Source } from './types';

/**
 * Draws the active scene's items onto the output canvas at 30fps, supports a 300ms crossfade on
 * scene switches, and exposes the canvas stream for recording/streaming. Items use normalized
 * coordinates so layouts survive resolution changes.
 */
export class Compositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sources = new Map<string, Source>();
  private scene: Scene | null = null;
  private prevScene: Scene | null = null;
  private fadeStart = 0;
  private raf = 0;
  private minInterval = 1000 / 30; // cap preview at 30fps; raised during native sessions
  private lastRender = 0;
  private static FADE_MS = 300;

  constructor(width = 1920, height = 1080) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
    const loop = (t: number) => {
      if (t - this.lastRender >= this.minInterval) {
        this.lastRender = t;
        this.render();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Throttle the preview to free the iGPU for ddagrab+QSV during native streaming/recording
   *  (the composited canvas isn't part of the native stream — it's only a monitor). */
  setPreviewFps(fps: number) {
    this.minInterval = 1000 / Math.max(1, fps);
  }

  registerSource(s: Source) {
    this.sources.set(s.id, s);
  }

  unregisterSource(id: string) {
    this.sources.delete(id);
  }

  setScene(scene: Scene, fade = true) {
    if (fade && this.scene && scene.id !== this.scene.id) {
      this.prevScene = this.scene;
      this.fadeStart = performance.now();
    }
    this.scene = scene;
  }

  get activeScene(): Scene | null {
    return this.scene;
  }

  captureStream(fps = 30): MediaStream {
    return this.canvas.captureStream(fps);
  }

  screenshot(): string {
    return this.canvas.toDataURL('image/png');
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }

  private render() {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const fadeT = this.prevScene
      ? Math.min(1, (performance.now() - this.fadeStart) / Compositor.FADE_MS)
      : 1;
    if (this.prevScene && fadeT < 1) {
      this.drawScene(this.prevScene, 1 - fadeT);
      this.drawScene(this.scene, fadeT);
    } else {
      this.prevScene = null;
      this.drawScene(this.scene, 1);
    }
  }

  private drawScene(scene: Scene | null, alpha: number) {
    if (!scene) return;
    const { ctx, canvas } = this;
    ctx.globalAlpha = alpha;
    const items = [...scene.items].sort((a, b) => a.z - b.z);
    for (const item of items) {
      const src = this.sources.get(item.sourceId);
      const v = src?.video;
      if (!v || !srcWidth(v)) continue;
      const x = item.x * canvas.width;
      const y = item.y * canvas.height;
      const w = item.w * canvas.width;
      const h = item.h * canvas.height;
      ctx.save();
      if (item.accent) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 18);
        ctx.clip();
      }
      this.drawCover(v, x, y, w, h, src!.rotation ?? 0);
      ctx.restore();
      if (item.accent) {
        ctx.strokeStyle = '#e53935';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 18);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawCover(
    v: HTMLVideoElement | HTMLCanvasElement,
    x: number,
    y: number,
    w: number,
    h: number,
    rotation = 0,
  ) {
    const rot = ((rotation % 360) + 360) % 360;
    const swapped = rot === 90 || rot === 270;
    const vw = swapped ? srcHeight(v) : srcWidth(v);
    const vh = swapped ? srcWidth(v) : srcHeight(v);
    const s = Math.max(w / vw, h / vh);
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate((rot * Math.PI) / 180);
    const dw = srcWidth(v) * s;
    const dh = srcHeight(v) * s;
    ctx.drawImage(v, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
}

function srcWidth(v: HTMLVideoElement | HTMLCanvasElement): number {
  return v instanceof HTMLVideoElement ? v.videoWidth : v.width;
}
function srcHeight(v: HTMLVideoElement | HTMLCanvasElement): number {
  return v instanceof HTMLVideoElement ? v.videoHeight : v.height;
}

/** Built-in layout presets. */
export function presetScenes(screenId: string | null, camId: string | null): Scene[] {
  const scenes: Scene[] = [];
  if (screenId) {
    scenes.push({
      id: 'scene-screen',
      name: 'Screen',
      hotkey: 'F1',
      items: [{ sourceId: screenId, x: 0, y: 0, w: 1, h: 1, z: 0 }],
    });
  }
  if (camId) {
    scenes.push({
      id: 'scene-camera',
      name: 'Camera',
      hotkey: 'F2',
      items: [{ sourceId: camId, x: 0, y: 0, w: 1, h: 1, z: 0 }],
    });
  }
  if (screenId && camId) {
    scenes.push({
      id: 'scene-pip',
      name: 'Screen + Cam',
      hotkey: 'F3',
      items: [
        { sourceId: screenId, x: 0, y: 0, w: 1, h: 1, z: 0 },
        { sourceId: camId, x: 0.73, y: 0.68, w: 0.24, h: 0.27, z: 1, accent: true },
      ],
    });
    scenes.push({
      id: 'scene-split',
      name: 'Side by side',
      hotkey: 'F4',
      items: [
        { sourceId: screenId, x: 0, y: 0.125, w: 0.5, h: 0.75, z: 0 },
        { sourceId: camId, x: 0.5, y: 0.125, w: 0.5, h: 0.75, z: 1 },
      ],
    });
  }
  return scenes;
}
