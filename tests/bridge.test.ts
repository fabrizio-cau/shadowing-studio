// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=abcdefghijk"}
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlayerBridge, type PortLike } from '../src/content/bridge';
import { cleanTitle, pageKind, videoIdFromUrl } from '../src/content/page';
import type { PlayerCommand, PlayerEvent, PlayerState } from '../src/shared/messages';

/** A <video> with scripted media behaviour that dispatches real DOM events. */
function makeVideo(opts: { duration?: number } = {}) {
  const v = document.createElement('video');
  v.className = 'html5-main-video';
  let t = 0;
  let paused = true;
  const duration = opts.duration ?? 120;
  const fire = (type: string) => v.dispatchEvent(new Event(type));
  Object.defineProperties(v, {
    readyState: { get: () => 4, configurable: true },
    duration: { get: () => duration, configurable: true },
    paused: { get: () => paused, configurable: true },
    seeking: { get: () => false, configurable: true },
    playbackRate: { get: () => 1, set() {}, configurable: true },
    currentTime: {
      get: () => t,
      set: (x: number) => {
        t = x;
        fire('seeking');
        fire('seeked');
      },
      configurable: true,
    },
  });
  v.play = () => {
    paused = false;
    fire('play');
    fire('playing');
    return Promise.resolve();
  };
  v.pause = () => {
    paused = true;
    fire('pause');
  };
  return {
    v,
    fire,
    /** Playback progresses to `x` (emits timeupdate). */
    playTo(x: number) {
      t = x;
      fire('timeupdate');
    },
  };
}

class FakePort implements PortLike {
  received: PlayerEvent[] = [];
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  postMessage(message: PlayerEvent) {
    this.received.push(structuredClone(message));
  }
  onMessage = { addListener: (fn: (m: unknown) => void) => this.messageListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => this.disconnectListeners.push(fn) };
  send(cmd: PlayerCommand | unknown) {
    for (const l of this.messageListeners) l(cmd);
  }
  disconnect() {
    for (const l of this.disconnectListeners) l();
  }
  states(): PlayerState[] {
    return this.received.filter((e): e is Extract<PlayerEvent, { type: 'state' }> => e.type === 'state').map((e) => e.state);
  }
  last(): PlayerState {
    return this.states().at(-1)!;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function navigate(path: string) {
  history.pushState({}, '', path);
  document.dispatchEvent(new Event('yt-navigate-finish'));
}

describe('page helpers', () => {
  it('classifies YouTube URLs', () => {
    expect(pageKind('https://www.youtube.com/watch?v=abcdefghijk&t=10s')).toBe('watch');
    expect(pageKind('https://www.youtube.com/watch?v=short')).toBe('other');
    expect(pageKind('https://www.youtube.com/shorts/abcdefghijk')).toBe('shorts');
    expect(pageKind('https://www.youtube.com/')).toBe('other');
    expect(pageKind('https://example.com/watch?v=abcdefghijk')).toBe('other');
    expect(pageKind('not a url')).toBe('other');
    expect(videoIdFromUrl('https://www.youtube.com/watch?list=x&v=abcdefghijk')).toBe('abcdefghijk');
  });

  it('cleans titles', () => {
    expect(cleanTitle('(3) Learn Spanish - YouTube')).toBe('Learn Spanish');
    expect(cleanTitle('YouTube')).toBe('YouTube');
  });
});

describe('PlayerBridge (content script ↔ side panel)', () => {
  let bridge: PlayerBridge;
  let player: HTMLDivElement;

  beforeEach(() => {
    history.replaceState({}, '', '/watch?v=abcdefghijk');
    document.title = 'Sentence practice - YouTube';
    document.body.innerHTML = '';
    player = document.createElement('div');
    player.className = 'html5-video-player';
    document.body.append(player);
  });

  afterEach(() => bridge?.destroy());

  it('sends the current state when the panel connects', async () => {
    const { v } = makeVideo();
    player.append(v);
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    expect(port.last()).toMatchObject({ status: { kind: 'ready' }, videoId: 'abcdefghijk', title: 'Sentence practice', duration: 120, paused: true, loopMode: 'off', segment: null });
  });

  it('reports pages without a video', () => {
    history.replaceState({}, '', '/feed/subscriptions');
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    expect(port.last().status).toEqual({ kind: 'not-watch' });
  });

  it('reports a watch page whose video has not appeared yet, then picks it up', async () => {
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    expect(port.last().status).toEqual({ kind: 'waiting' });
    const { v, fire } = makeVideo();
    player.append(v);
    fire('loadedmetadata'); // captured on the document
    await flush();
    expect(port.last().status).toEqual({ kind: 'ready' });
  });

  it('marks Shorts and live streams as unsupported', () => {
    const { v } = makeVideo({ duration: Infinity });
    player.append(v);
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    expect(port.last().status).toMatchObject({ kind: 'unsupported', reason: expect.stringMatching(/Live/) });
    navigate('/shorts/abcdefghijk');
    bridge.addPort(port);
    expect(port.last().status).toMatchObject({ kind: 'unsupported', reason: expect.stringMatching(/Shorts/) });
  });

  it('loops a segment on command and notifies the panel at each end', async () => {
    const video = makeVideo();
    player.append(video.v);
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    port.send({ type: 'setSegment', segment: { start: 10, end: 12 } });
    port.send({ type: 'playSegment', mode: 'loop' });
    await flush();
    expect(video.v.currentTime).toBe(10);
    expect(video.v.paused).toBe(false);
    expect(port.last()).toMatchObject({ loopMode: 'loop', segment: { start: 10, end: 12 } });
    video.playTo(12.01);
    expect(video.v.currentTime).toBe(10);
    expect(port.received).toContainEqual({ type: 'segmentEnd', mode: 'loop', pass: 1 });
    port.send({ type: 'setLoopMode', mode: 'off' });
    await flush();
    expect(port.last().loopMode).toBe('off');
  });

  it('pauses at the end in play-once mode (listen & repeat)', async () => {
    const video = makeVideo();
    player.append(video.v);
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    port.send({ type: 'setSegment', segment: { start: 1, end: 2 } });
    port.send({ type: 'playSegment', mode: 'once' });
    video.playTo(2);
    await flush();
    expect(video.v.paused).toBe(true);
    expect(port.received).toContainEqual({ type: 'segmentEnd', mode: 'once', pass: 1 });
    expect(port.last().loopMode).toBe('off');
  });

  it('answers invalid commands with an error instead of throwing', async () => {
    const { v } = makeVideo();
    player.append(v);
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    port.send({ type: 'setSegment', segment: { start: 5, end: 1 } });
    port.send({ type: 'playSegment', mode: 'loop' }); // no segment yet
    port.send({ type: 'seek', time: -3 });
    port.send({ type: 'bogus' }); // ignored
    port.send(null); // ignored
    const errors = port.received.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(3);
  });

  it('resets the segment when YouTube navigates to another video (SPA)', async () => {
    const video = makeVideo();
    player.append(video.v);
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    port.send({ type: 'setSegment', segment: { start: 1, end: 3 } });
    port.send({ type: 'playSegment', mode: 'loop' });
    document.title = 'Another video - YouTube';
    navigate('/watch?v=zyxwvutsrqp');
    await flush();
    expect(port.last()).toMatchObject({ videoId: 'zyxwvutsrqp', title: 'Another video', segment: null, loopMode: 'off' });
    // The old segment no longer constrains playback.
    video.playTo(3.5);
    expect(video.v.currentTime).toBe(3.5);
  });

  it('notices video changes from media events alone (no navigation event)', async () => {
    const video = makeVideo();
    player.append(video.v);
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    history.pushState({}, '', '/watch?v=zyxwvutsrqp');
    video.fire('loadstart');
    await flush();
    expect(port.last().videoId).toBe('zyxwvutsrqp');
  });

  it('moves to a replacement <video> element and detaches from the old one', async () => {
    const first = makeVideo();
    player.append(first.v);
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    port.send({ type: 'setSegment', segment: { start: 1, end: 3 } });

    first.v.remove();
    const second = makeVideo();
    player.append(second.v);
    second.fire('loadstart');
    await flush();

    port.send({ type: 'playSegment', mode: 'loop' });
    expect(second.v.paused).toBe(false);
    expect(second.v.currentTime).toBe(1);
    // The old element is no longer controlled.
    void first.v.play();
    first.playTo(5);
    expect(first.v.currentTime).toBe(5);
    // Same video: the segment survived the element swap.
    expect(port.last().segment).toEqual({ start: 1, end: 3 });
  });

  it('keeps looping when the panel disconnects, and reports it on reconnect', async () => {
    const video = makeVideo();
    player.append(video.v);
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    port.send({ type: 'setSegment', segment: { start: 4, end: 6 } });
    port.send({ type: 'playSegment', mode: 'loop' });
    port.disconnect();
    const before = port.received.length;
    video.playTo(6);
    await flush();
    expect(video.v.currentTime).toBe(4);
    expect(port.received.length).toBe(before); // nothing sent to a closed panel
    const again = new FakePort();
    bridge.addPort(again);
    expect(again.last()).toMatchObject({ loopMode: 'loop', segment: { start: 4, end: 6 } });
  });

  it('suspends the loop while an ad is showing', async () => {
    const video = makeVideo();
    player.append(video.v);
    bridge = new PlayerBridge({ doc: document, win: window });
    const port = new FakePort();
    bridge.addPort(port);
    port.send({ type: 'setSegment', segment: { start: 1, end: 2 } });
    port.send({ type: 'playSegment', mode: 'loop' });
    player.classList.add('ad-showing');
    video.playTo(15);
    await flush();
    expect(video.v.currentTime).toBe(15);
    expect(port.last().isAd).toBe(true);
  });
});
