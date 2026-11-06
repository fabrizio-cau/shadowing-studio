import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOOKAHEAD_SECONDS, LoopController } from '../src/content/loop';
import { FakeMedia } from './fakes';

/** Simulates real playback: media time advances with the (fake) clock, timeupdate every 250 ms. */
function playFor(media: FakeMedia, seconds: number, step = 0.25): void {
  const steps = Math.round(seconds / step);
  for (let i = 0; i < steps; i++) {
    // Timers due within this step fire at their exact time, before the next timeupdate.
    const before = media.currentTime;
    const dueIn = vi.getTimerCount() > 0;
    if (dueIn) {
      // Advance in 5 ms slices so the precise timer observes the right media time.
      for (let t = 0; t < step * 1000; t += 5) {
        if (!media.paused && !media.seeking) media.setTimeSilently(Math.min(media.duration, media.currentTime + 0.005 * media.playbackRate));
        vi.advanceTimersByTime(5);
      }
      if (media.currentTime !== before) media.emit('timeupdate');
    } else {
      vi.advanceTimersByTime(step * 1000);
      media.advance(step);
    }
  }
}

describe('LoopController', () => {
  let media: FakeMedia;
  let onSegmentEnd: ReturnType<typeof vi.fn<(mode: "loop" | "once", pass: number) => void>>;
  let loop: LoopController;

  beforeEach(() => {
    vi.useFakeTimers();
    media = new FakeMedia();
    onSegmentEnd = vi.fn<(mode: "loop" | "once", pass: number) => void>();
    loop = new LoopController(media, { onSegmentEnd });
  });

  afterEach(() => {
    loop.detach();
    vi.useRealTimers();
  });

  it('starts playback at the segment start', () => {
    loop.setSegment({ start: 10, end: 12 });
    loop.playSegment('loop');
    expect(media.seeks).toEqual([10]);
    expect(media.paused).toBe(false);
    expect(loop.mode).toBe('loop');
  });

  it('seeks back to the start when the end is reached, repeatedly', () => {
    loop.setSegment({ start: 10, end: 12 });
    loop.playSegment('loop');
    playFor(media, 2.1);
    expect(onSegmentEnd).toHaveBeenCalledWith('loop', 1);
    expect(media.seeks).toEqual([10, 10]);
    playFor(media, 2.0);
    playFor(media, 2.0);
    expect(onSegmentEnd).toHaveBeenCalledTimes(3);
    expect(onSegmentEnd).toHaveBeenLastCalledWith('loop', 3);
    // Never strays past the end by more than a few ms.
    expect(media.currentTime).toBeLessThan(12.05);
  });

  it('detects the end precisely, not at the next timeupdate', () => {
    loop.setSegment({ start: 0, end: 1.1 });
    loop.playSegment('loop');
    media.setTimeSilently(0.9); // 200 ms before the end; the next timeupdate would come 250 ms later
    media.emit('timeupdate');
    expect(loop.timerArmed).toBe(true);
    vi.advanceTimersByTime(150);
    expect(onSegmentEnd).not.toHaveBeenCalled();
    media.setTimeSilently(1.1);
    vi.advanceTimersByTime(50);
    expect(onSegmentEnd).toHaveBeenCalledTimes(1);
    expect(media.currentTime).toBe(0);
  });

  it('re-arms when the timer fires slightly early', () => {
    loop.setSegment({ start: 0, end: 1 });
    loop.playSegment('loop');
    media.setTimeSilently(0.8);
    media.emit('timeupdate');
    media.setTimeSilently(0.95); // media clock lagged behind the wall clock
    vi.advanceTimersByTime(200);
    expect(onSegmentEnd).not.toHaveBeenCalled();
    expect(loop.timerArmed).toBe(true);
    media.setTimeSilently(1);
    vi.advanceTimersByTime(50);
    expect(onSegmentEnd).toHaveBeenCalledTimes(1);
  });

  it.each([0.5, 1, 1.5, 2])('loops correctly at %sx speed', (rate) => {
    media.playbackRate = rate;
    loop.setSegment({ start: 5, end: 7 });
    loop.playSegment('loop');
    playFor(media, (2 / rate) * 3 + 0.1);
    expect(onSegmentEnd).toHaveBeenCalledTimes(3);
    expect(media.currentTime).toBeGreaterThanOrEqual(5);
    expect(media.currentTime).toBeLessThan(7.05);
  });

  it('in once mode pauses at the end and switches off', () => {
    loop.setSegment({ start: 1, end: 2 });
    loop.playSegment('once');
    playFor(media, 1.2);
    expect(media.paused).toBe(true);
    expect(loop.mode).toBe('off');
    expect(onSegmentEnd).toHaveBeenCalledWith('once', 1);
    // Pressing play again must not immediately pause.
    void media.play();
    playFor(media, 0.5);
    expect(media.paused).toBe(false);
  });

  it('stops looping when cancelled', () => {
    loop.setSegment({ start: 1, end: 2 });
    loop.playSegment('loop');
    playFor(media, 0.8);
    loop.setMode('off');
    expect(loop.timerArmed).toBe(false);
    playFor(media, 2);
    expect(onSegmentEnd).not.toHaveBeenCalled();
    expect(media.currentTime).toBeGreaterThan(2);
  });

  it('clearing the segment turns the loop off', () => {
    loop.setSegment({ start: 1, end: 2 });
    loop.playSegment('loop');
    loop.setSegment(null);
    expect(loop.mode).toBe('off');
    expect(() => loop.setMode('loop')).toThrow();
  });

  it('never arms more than one timer, however many events arrive', () => {
    loop.setSegment({ start: 0, end: 1 });
    loop.playSegment('loop');
    media.setTimeSilently(1 - LOOKAHEAD_SECONDS / 2);
    for (let i = 0; i < 20; i++) media.emit('timeupdate');
    media.emit('ratechange');
    media.emit('playing');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('arms no timer while paused, seeking or buffering', () => {
    loop.setSegment({ start: 0, end: 1 });
    loop.playSegment('loop');
    media.setTimeSilently(0.8);
    media.pause();
    expect(vi.getTimerCount()).toBe(0);
    void media.play();
    expect(vi.getTimerCount()).toBe(1);
    media.readyState = 2;
    media.emit('waiting');
    expect(vi.getTimerCount()).toBe(0);
    media.readyState = 4;
    media.emit('playing');
    expect(vi.getTimerCount()).toBe(1);
    media.autoCompleteSeeks = false;
    media.currentTime = 0.5;
    expect(media.seeking).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not seek again while a seek is still in progress (slow network)', () => {
    media.autoCompleteSeeks = false;
    loop.setSegment({ start: 3, end: 4 });
    loop.playSegment('loop');
    media.completeSeek();
    media.setTimeSilently(4);
    media.emit('timeupdate');
    expect(media.seeks).toEqual([3, 3]);
    // More events arrive while seeking: no extra seeks.
    media.emit('timeupdate');
    media.emit('timeupdate');
    expect(media.seeks).toEqual([3, 3]);
    media.completeSeek();
    expect(media.currentTime).toBe(3);
    expect(onSegmentEnd).toHaveBeenCalledTimes(1);
  });

  it('snaps back to the start if the user seeks before the segment while looping', () => {
    loop.setSegment({ start: 10, end: 12 });
    loop.playSegment('loop');
    media.currentTime = 2;
    expect(media.currentTime).toBe(10);
  });

  it('handles a segment that ends at the end of the video', () => {
    media.duration = 20;
    loop.setSegment({ start: 18, end: 20 });
    loop.playSegment('loop');
    media.setTimeSilently(19.9);
    loop.detach(); // simulate the timer missing it: only `ended` remains
    loop = new LoopController(media, { onSegmentEnd });
    loop.setSegment({ start: 18, end: 20 });
    loop.setMode('loop');
    media.setTimeSilently(20);
    media.paused = true;
    media.emit('ended');
    expect(media.currentTime).toBe(18);
    expect(media.paused).toBe(false);
    expect(onSegmentEnd).toHaveBeenCalledWith('loop', 1);
  });

  it('does nothing while suspended (ads)', () => {
    let ad = true;
    loop.detach();
    loop = new LoopController(media, { onSegmentEnd, isSuspended: () => ad });
    loop.setSegment({ start: 0, end: 1 });
    loop.playSegment('loop');
    playFor(media, 1.5);
    expect(onSegmentEnd).not.toHaveBeenCalled();
    ad = false;
    media.emit('timeupdate');
    expect(onSegmentEnd).toHaveBeenCalledTimes(1);
  });

  it('removes all listeners and timers on detach', () => {
    const fresh = new FakeMedia();
    const c = new LoopController(fresh);
    expect(fresh.listenerCount()).toBeGreaterThan(0);
    c.setSegment({ start: 0, end: 0.3 });
    c.playSegment('loop');
    c.detach();
    expect(fresh.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports blocked playback', async () => {
    const onError = vi.fn();
    const m = new FakeMedia();
    m.play = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    const c = new LoopController(m, { onError });
    c.setSegment({ start: 0, end: 1 });
    c.playSegment('loop');
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/blocked/));
    c.detach();
  });
});
