import type { MediaLike } from '../src/content/loop';

/**
 * A scripted media element. Time only moves when the test calls `advance()`, which emits
 * `timeupdate` like a real element (≈ every 250 ms). Seeks complete on `completeSeek()`.
 */
export class FakeMedia implements MediaLike {
  duration = 100;
  paused = true;
  seeking = false;
  playbackRate = 1;
  readyState = 4;
  seeks: number[] = [];
  playCalls = 0;
  pauseCalls = 0;
  private time = 0;
  private listeners = new Map<string, Set<() => void>>();
  autoCompleteSeeks = true;

  get currentTime(): number {
    return this.time;
  }

  set currentTime(t: number) {
    this.time = t;
    this.seeks.push(t);
    this.seeking = true;
    this.emit('seeking');
    if (this.autoCompleteSeeks) this.completeSeek();
  }

  completeSeek(): void {
    this.seeking = false;
    this.emit('seeked');
    this.emit('timeupdate');
  }

  play(): Promise<void> {
    this.playCalls++;
    if (this.paused) {
      this.paused = false;
      this.emit('play');
      this.emit('playing');
    }
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls++;
    if (!this.paused) {
      this.paused = true;
      this.emit('pause');
    }
  }

  /** Advances media time by `seconds` (scaled by playbackRate), emitting timeupdate. */
  advance(realSeconds: number): void {
    if (this.paused || this.seeking) return;
    this.time = Math.min(this.duration, this.time + realSeconds * this.playbackRate);
    this.emit('timeupdate');
    if (this.time >= this.duration) {
      this.paused = true;
      this.emit('pause');
      this.emit('ended');
    }
  }

  /** Jumps time without the seek machinery (e.g. to land exactly where a timer fires). */
  setTimeSilently(t: number): void {
    this.time = t;
  }

  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  emit(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
}
