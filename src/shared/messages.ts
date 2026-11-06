/** Typed message contracts shared by both ends of each port. */

export const PLAYER_PORT = 'yss-player';
export const PANEL_PORT = 'yss-panel';

export type LoopMode = 'off' | 'loop' | 'once';

export type PageStatus =
  | { kind: 'not-watch' } // a YouTube page that is not a /watch page
  | { kind: 'unsupported'; reason: string } // live stream, etc.
  | { kind: 'waiting' } // watch page whose <video> is missing or has no metadata yet
  | { kind: 'ready' };

export interface PlayerState {
  status: PageStatus;
  videoId: string | null;
  url: string;
  title: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  buffering: boolean;
  isAd: boolean;
  loopMode: LoopMode;
  segment: { start: number; end: number } | null;
}

/** Side panel → content script. */
export type PlayerCommand =
  | { type: 'getState' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'setSegment'; segment: { start: number; end: number } | null }
  | { type: 'setLoopMode'; mode: LoopMode }
  /** Seek to the segment start, set the loop mode and play. */
  | { type: 'playSegment'; mode: Exclude<LoopMode, 'off'> };

/** Content script → side panel. */
export type PlayerEvent =
  | { type: 'state'; state: PlayerState }
  /** Playback reached the segment end; `mode` is the loop mode that handled it. */
  | { type: 'segmentEnd'; mode: Exclude<LoopMode, 'off'>; pass: number }
  | { type: 'error'; message: string };

/** Side panel → service worker. */
export type PanelMessage = { type: 'recording'; active: boolean };

const COMMAND_TYPES = new Set<PlayerCommand['type']>(['getState', 'play', 'pause', 'seek', 'setSegment', 'setLoopMode', 'playSegment']);

export function isPlayerCommand(value: unknown): value is PlayerCommand {
  return typeof value === 'object' && value !== null && COMMAND_TYPES.has((value as { type: PlayerCommand['type'] }).type);
}
