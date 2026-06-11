/**
 * MediaRecorder wrapper. Prefers H.264 capture so the ffmpeg finalize is a fast remux into a
 * REAL .mp4 (video copy, audio→AAC); falls back to VP9/webm where H.264 capture is unavailable.
 */
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startMs = 0;
  private pausedMs = 0;
  private pauseStart = 0;
  private usedH264 = false;

  get state(): RecordingState {
    return this.recorder?.state ?? 'inactive';
  }

  get elapsedMs(): number {
    if (!this.recorder || this.recorder.state === 'inactive') return 0;
    const base = this.recorder.state === 'paused' ? this.pauseStart : Date.now();
    return base - this.startMs - this.pausedMs;
  }

  private pickMime(): { mime: string; h264: boolean } {
    const candidates: Array<{ mime: string; h264: boolean }> = [
      { mime: 'video/x-matroska;codecs=avc1,opus', h264: true },
      { mime: 'video/webm;codecs=h264,opus', h264: true },
      { mime: 'video/webm;codecs=vp9,opus', h264: false },
      { mime: 'video/webm', h264: false },
    ];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    }
    return candidates[candidates.length - 1];
  }

  start(video: MediaStream, audio: MediaStream, onSaved: (path: string | null) => void) {
    const out = new MediaStream([...video.getVideoTracks(), ...audio.getAudioTracks()]);
    const { mime, h264 } = this.pickMime();
    this.usedH264 = h264;
    this.chunks = [];
    this.recorder = new MediaRecorder(out, {
      mimeType: mime,
      videoBitsPerSecond: 8_000_000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.recorder.onstop = async () => {
      const blob = new Blob(this.chunks);
      const saved = await window.screencap.finalizeRecording(await blob.arrayBuffer(), this.usedH264);
      onSaved(saved);
    };
    this.recorder.start(1000);
    this.startMs = Date.now();
    this.pausedMs = 0;
  }

  togglePause() {
    if (!this.recorder) return;
    if (this.recorder.state === 'recording') {
      this.recorder.pause();
      this.pauseStart = Date.now();
    } else if (this.recorder.state === 'paused') {
      this.recorder.resume();
      this.pausedMs += Date.now() - this.pauseStart;
    }
  }

  stop() {
    this.recorder?.stop();
  }
}

/** Desktop Go-LIVE: timesliced capture piped to the main process's ffmpeg → RTMP. */
export class Streamer {
  private recorder: MediaRecorder | null = null;
  live = false;

  async start(video: MediaStream, audio: MediaStream, url: string, key: string, bitrateK: number): Promise<string | null> {
    const res = await window.screencap.streamStart(url, key, bitrateK);
    if (!res.ok) return res.error ?? 'failed';
    const out = new MediaStream([...video.getVideoTracks(), ...audio.getAudioTracks()]);
    const mime = MediaRecorder.isTypeSupported('video/x-matroska;codecs=avc1,opus')
      ? 'video/x-matroska;codecs=avc1,opus'
      : 'video/webm;codecs=vp9,opus';
    this.recorder = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    this.recorder.ondataavailable = async (e) => {
      if (e.data.size) window.screencap.streamChunk(await e.data.arrayBuffer());
    };
    this.recorder.start(250); // 4 chunks/s into the ffmpeg pipe
    this.live = true;
    return null;
  }

  stop() {
    this.live = false;
    this.recorder?.stop();
    this.recorder = null;
    void window.screencap.streamStop();
  }
}
