import type { LoopMode } from '../shared/messages';

/** The subset of HTMLMediaElement the loop needs; lets tests drive it with a fake. */
export interface MediaLike {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly playbackRate: number;
  readonly readyState: number;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface LoopOptions {
  timers?: Timers;
  /** Called every time playback reaches the segment end. */
  onSegmentEnd?: (mode: Exclude<LoopMode, 'off'>, pass: number) => void;
  /** Called after the controller changes its own mode (e.g. `once` → `off`). */
  onModeChange?: (mode: LoopMode) => void;
  /** While true (e.g. an ad is playing) the loop does nothing. */
  isSuspended?: () => boolean;
  onError?: (message: string) => void;
}

/** We treat "within 30 ms of the end" as having reached it. */
export const END_EPSILON = 0.03;
/** Arm the precise timer when the end is this many real seconds away (timeupdate is ~4 Hz). */
export const LOOKAHEAD_SECONDS = 0.6;
/** In loop mode, playback this far before the start (user seeked away) snaps back to the start. */
export const SNAP_BEFORE_START = 0.25;
const HAVE_FUTURE_DATA = 3;

const EVENTS = ['timeupdate', 'play', 'playing', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'canplay', 'ended'] as const;

/**
 * Keeps playback inside a segment. Event-driven: media events re-evaluate the position and,
 * close to the end, a single precise timeout is armed. There is never more than one timer,
 * and none while paused, seeking or buffering.
 */
export class LoopController {
  private segment: { start: number; end: number } | null = null;
  private loopMode: LoopMode = 'off';
  private timer: unknown = null;
  private pass = 0;
  private readonly timers: Timers;
  private readonly listener = () => this.evaluate();
  private readonly endedListener = () => this.onEnded();

  constructor(private readonly media: MediaLike, private readonly options: LoopOptions = {}) {
    this.timers = options.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as number) };
    for (const type of EVENTS) {
      if (type !== 'ended') media.addEventListener(type, this.listener);
    }
    media.addEventListener('ended', this.endedListener);
  }

  get mode(): LoopMode {
    return this.loopMode;
  }

  get bounds(): { start: number; end: number } | null {
    return this.segment;
  }

  /** True while a precise end-of-segment timer is armed (exposed for tests). */
  get timerArmed(): boolean {
    return this.timer !== null;
  }

  setSegment(segment: { start: number; end: number } | null): void {
    this.segment = segment ? { ...segment } : null;
    if (!segment) this.setModeInternal('off');
    this.evaluate();
  }

  setMode(mode: LoopMode): void {
    if (mode !== 'off' && !this.segment) throw new Error('Set a segment before enabling the loop.');
    this.pass = 0;
    this.setModeInternal(mode);
    this.evaluate();
  }

  /** Seeks to the segment start and plays in the given mode. */
  playSegment(mode: Exclude<LoopMode, 'off'>): void {
    if (!this.segment) throw new Error('Set a segment first.');
    this.pass = 0;
    this.setModeInternal(mode);
    this.clearTimer();
    this.media.currentTime = this.segment.start;
    this.play();
  }

  detach(): void {
    this.clearTimer();
    for (const type of EVENTS) {
      if (type !== 'ended') this.media.removeEventListener(type, this.listener);
    }
    this.media.removeEventListener('ended', this.endedListener);
  }

  /** Re-checks the position. Called on every relevant media event and by the timer. */
  evaluate(): void {
    this.clearTimer();
    const seg = this.segment;
    if (this.loopMode === 'off' || !seg) return;
    if (this.options.isSuspended?.()) return;
    const m = this.media;
    if (m.seeking || m.paused) return;

    const t = m.currentTime;
    if (t >= seg.end - END_EPSILON) {
      this.reachEnd();
      return;
    }
    if (this.loopMode === 'loop' && t < seg.start - SNAP_BEFORE_START) {
      m.currentTime = seg.start;
      return;
    }
    // While buffering, time does not advance; wait for `playing`/`canplay` instead of re-arming.
    if (m.readyState < HAVE_FUTURE_DATA) return;

    const rate = m.playbackRate > 0 ? m.playbackRate : 1;
    const remaining = (seg.end - t) / rate;
    if (remaining <= LOOKAHEAD_SECONDS) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        this.evaluate();
      }, Math.max(remaining * 1000, 5));
    }
  }

  private reachEnd(): void {
    const seg = this.segment;
    if (!seg) return;
    this.pass += 1;
    if (this.loopMode === 'loop') {
      this.media.currentTime = seg.start;
      this.options.onSegmentEnd?.('loop', this.pass);
    } else if (this.loopMode === 'once') {
      this.media.pause();
      // Switch off so that pressing play from here does not immediately pause again.
      this.setModeInternal('off');
      this.options.onSegmentEnd?.('once', this.pass);
    }
  }

  /** A segment that ends at the very end of the video arrives here: the element has paused itself. */
  private onEnded(): void {
    if (this.loopMode === 'off' || !this.segment || this.options.isSuspended?.()) return;
    const wasLoop = this.loopMode === 'loop';
    this.reachEnd();
    if (wasLoop) this.play();
  }

  private play(): void {
    try {
      const result = this.media.play();
      if (result && typeof result.catch === 'function') {
        result.catch((err: unknown) => this.options.onError?.(`Playback was blocked: ${String(err)}`));
      }
    } catch (err) {
      this.options.onError?.(`Playback failed: ${String(err)}`);
    }
  }

  private setModeInternal(mode: LoopMode): void {
    if (mode === this.loopMode) return;
    this.loopMode = mode;
    if (mode === 'off') this.clearTimer();
    this.options.onModeChange?.(mode);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
