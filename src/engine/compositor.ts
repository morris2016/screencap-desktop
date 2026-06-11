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
  private static FADE_MS = 300;

  constructor(width = 1920, height = 1080) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
    const loop = () => {
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
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
      if (!v || !v.videoWidth) continue;
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
      this.drawCover(v, x, y, w, h);
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

  private drawCover(v: HTMLVideoElement, x: number, y: number, w: number, h: number) {
    const s = Math.max(w / v.videoWidth, h / v.videoHeight);
    const dw = v.videoWidth * s;
    const dh = v.videoHeight * s;
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  }
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
