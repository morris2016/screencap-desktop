/** MediaRecorder wrapper: pause-aware timer, chunked capture, native save via IPC. */
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startMs = 0;
  private pausedMs = 0;
  private pauseStart = 0;

  get state(): RecordingState {
    return this.recorder?.state ?? 'inactive';
  }

  get elapsedMs(): number {
    if (!this.recorder || this.recorder.state === 'inactive') return 0;
    const base = this.recorder.state === 'paused' ? this.pauseStart : Date.now();
    return base - this.startMs - this.pausedMs;
  }

  start(video: MediaStream, audio: MediaStream, onSaved: (path: string | null) => void) {
    const out = new MediaStream([
      ...video.getVideoTracks(),
      ...audio.getAudioTracks(),
    ]);
    this.chunks = [];
    this.recorder = new MediaRecorder(out, {
      mimeType: 'video/webm;codecs=vp9,opus',
      videoBitsPerSecond: 8_000_000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.recorder.onstop = async () => {
      const blob = new Blob(this.chunks, { type: 'video/webm' });
      const name = `ScreenCap_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
      const saved = await window.screencap.saveRecording(await blob.arrayBuffer(), name);
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
