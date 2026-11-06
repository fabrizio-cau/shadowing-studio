export type PracticeMode = 'shadowing' | 'repeat';

/** A saved practice segment (IndexedDB `segments`). */
export interface Segment {
  id: string;
  videoId: string;
  videoUrl: string;
  videoTitle: string;
  language: string;
  start: number;
  end: number;
  /** 1-based number of the segment within its video, used in export names. */
  number: number;
  /** Next attempt number to hand out. Never decreases, so numbers are not reused after deletion. */
  nextAttempt: number;
  createdAt: number;
  updatedAt: number;
}

/** A recorded attempt (IndexedDB `recordings`). */
export interface Recording {
  id: string;
  segmentId: string;
  attempt: number;
  createdAt: number;
  durationMs: number;
  mimeType: string;
  blob: Blob;
  name: string;
  notes: string;
  /** True when rebuilt from saved chunks after the panel closed mid-recording. */
  recovered?: boolean;
}

export interface Settings {
  mode: PracticeMode;
  language: string;
  /** Shadowing: stop the attempt automatically when the segment reaches its end. */
  autoStop: boolean;
}

export const DEFAULT_SETTINGS: Settings = { mode: 'shadowing', language: 'English', autoStop: true };

export function watchUrl(videoId: string, start?: number): string {
  const base = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return start === undefined ? base : `${base}&t=${Math.floor(start)}s`;
}
