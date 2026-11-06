import { isPlayerCommand, type LoopMode, type PageStatus, type PlayerCommand, type PlayerEvent, type PlayerState } from '../shared/messages';
import { LoopController, type Timers } from './loop';
import { cleanTitle, findMainVideo, isAdShowing, pageKind, videoIdFromUrl } from './page';

/** The parts of chrome.runtime.Port the bridge uses. */
export interface PortLike {
  postMessage(message: PlayerEvent): void;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface BridgeEnv {
  doc: Document;
  win: Window;
  timers?: Timers;
}

/** Media events that can change what we report; captured on the document (they don't bubble). */
const STATE_EVENTS = ['timeupdate', 'play', 'pause', 'playing', 'waiting', 'seeked', 'ratechange', 'durationchange', 'ended', 'loadedmetadata', 'emptied', 'loadstart'];
/** Media events that may mean a different video or element: re-resolve. */
const RESOLVE_EVENTS = new Set(['loadstart', 'loadedmetadata', 'emptied', 'durationchange']);

/**
 * Owns the connection between YouTube's <video> and any connected side panels.
 * It is the source of truth for playback and loop state: the loop keeps running if the
 * panel closes, and a reconnecting panel receives the current state.
 */
export class PlayerBridge {
  private video: HTMLVideoElement | null = null;
  private loop: LoopController | null = null;
  private videoId: string | null = null;
  private segment: { start: number; end: number } | null = null;
  private ports = new Set<PortLike>();
  private pushQueued = false;
  private titleObserver: MutationObserver | null = null;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly env: BridgeEnv) {
    const { doc, win } = env;
    const onMediaEvent = (e: Event) => {
      if (!(e.target instanceof HTMLMediaElement)) return;
      if (RESOLVE_EVENTS.has(e.type)) this.resolve();
      else if (e.target === this.video) this.queuePush();
    };
    for (const type of STATE_EVENTS) {
      doc.addEventListener(type, onMediaEvent, true);
      this.cleanups.push(() => doc.removeEventListener(type, onMediaEvent, true));
    }
    const onNavigate = () => this.resolve();
    doc.addEventListener('yt-navigate-finish', onNavigate);
    win.addEventListener('popstate', onNavigate);
    this.cleanups.push(() => doc.removeEventListener('yt-navigate-finish', onNavigate));
    this.cleanups.push(() => win.removeEventListener('popstate', onNavigate));
    this.observeTitle();
    this.resolve();
  }

  addPort(port: PortLike): void {
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    port.onMessage.addListener((message) => {
      if (!isPlayerCommand(message)) return;
      try {
        this.handle(message);
      } catch (err) {
        this.send(port, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    });
    this.send(port, { type: 'state', state: this.state() });
  }

  destroy(): void {
    this.loop?.detach();
    this.titleObserver?.disconnect();
    for (const c of this.cleanups) c();
    this.ports.clear();
  }

  state(): PlayerState {
    const v = this.video;
    return {
      status: this.status(),
      videoId: this.videoId,
      url: this.env.win.location.href,
      title: cleanTitle(this.env.doc.title),
      currentTime: v ? v.currentTime : 0,
      duration: v && Number.isFinite(v.duration) ? v.duration : NaN,
      paused: v ? v.paused : true,
      playbackRate: v ? v.playbackRate : 1,
      buffering: v ? !v.paused && v.readyState < 3 : false,
      isAd: isAdShowing(v),
      loopMode: this.loop?.mode ?? 'off',
      segment: this.segment,
    };
  }

  private status(): PageStatus {
    const kind = pageKind(this.env.win.location.href);
    if (kind === 'shorts') return { kind: 'unsupported', reason: 'Shorts are not supported. Open a regular watch page.' };
    if (kind !== 'watch') return { kind: 'not-watch' };
    const v = this.video;
    if (!v || v.readyState < 1) return { kind: 'waiting' };
    if (v.duration === Infinity) return { kind: 'unsupported', reason: 'Live streams are not supported.' };
    return { kind: 'ready' };
  }

  /** Re-detects the page's video id and <video>; resets the segment when the video changes. */
  resolve(): void {
    const id = videoIdFromUrl(this.env.win.location.href);
    if (id !== this.videoId) {
      this.videoId = id;
      this.segment = null;
      this.loop?.setSegment(null);
    }
    const next = id ? findMainVideo(this.env.doc) : null;
    if (next !== this.video) {
      this.loop?.detach();
      this.loop = null;
      this.video = next;
      if (next) {
        this.loop = new LoopController(next, {
          timers: this.env.timers,
          isSuspended: () => isAdShowing(next),
          onSegmentEnd: (mode, pass) => this.broadcast({ type: 'segmentEnd', mode, pass }),
          onModeChange: () => this.queuePush(),
          onError: (message) => this.broadcast({ type: 'error', message }),
        });
        // A replaced element for the same video keeps the user's segment (but not a running loop).
        if (this.segment) this.loop.setSegment(this.segment);
      }
    }
    this.queuePush();
  }

  private handle(cmd: PlayerCommand): void {
    const v = this.video;
    switch (cmd.type) {
      case 'getState':
        this.queuePush();
        return;
      case 'setSegment': {
        const s = cmd.segment;
        if (s && !(Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start)) {
          throw new Error('Invalid segment.');
        }
        this.segment = s ? { start: s.start, end: s.end } : null;
        this.loop?.setSegment(this.segment);
        this.queuePush();
        return;
      }
    }
    if (!v || !this.loop) throw new Error('No video found on this page yet.');
    switch (cmd.type) {
      case 'play':
        this.loop.evaluate();
        void Promise.resolve(v.play()).catch((err: unknown) => this.broadcast({ type: 'error', message: `Playback was blocked: ${String(err)}` }));
        break;
      case 'pause':
        v.pause();
        break;
      case 'seek':
        if (!Number.isFinite(cmd.time) || cmd.time < 0) throw new Error('Invalid seek position.');
        v.currentTime = cmd.time;
        break;
      case 'setLoopMode':
        this.loop.setMode(cmd.mode satisfies LoopMode);
        break;
      case 'playSegment':
        this.loop.playSegment(cmd.mode);
        break;
    }
    this.queuePush();
  }

  /** Coalesces bursts of media events into one state message per task. */
  private queuePush(): void {
    if (this.pushQueued || this.ports.size === 0) return;
    this.pushQueued = true;
    queueMicrotask(() => {
      this.pushQueued = false;
      this.broadcast({ type: 'state', state: this.state() });
    });
  }

  private broadcast(event: PlayerEvent): void {
    for (const port of this.ports) this.send(port, event);
  }

  private send(port: PortLike, event: PlayerEvent): void {
    try {
      port.postMessage(event);
    } catch {
      // The panel went away between disconnect and our send; forget it.
      this.ports.delete(port);
    }
  }

  /** document.title changes after SPA navigation; the panel shows it. */
  private observeTitle(): void {
    const head = this.env.doc.head;
    if (!head || typeof MutationObserver === 'undefined') return;
    let last = this.env.doc.title;
    this.titleObserver = new MutationObserver(() => {
      if (this.env.doc.title !== last) {
        last = this.env.doc.title;
        this.queuePush();
      }
    });
    this.titleObserver.observe(head, { subtree: true, childList: true, characterData: true });
  }
}
