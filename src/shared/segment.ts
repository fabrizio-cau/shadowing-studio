/** Shortest segment we accept; anything shorter cannot be looped meaningfully. */
export const MIN_SEGMENT_SECONDS = 0.2;

export interface SegmentBounds {
  start: number;
  end: number;
}

/**
 * Validates segment bounds. `duration` is the video duration when known (finite);
 * pass undefined/NaN when the video has not loaded its metadata yet.
 * Returns a user-facing error message, or null when valid.
 */
export function validateSegment(start: number | null, end: number | null, duration?: number): string | null {
  if (start === null || !Number.isFinite(start)) return 'Start time is not a valid timestamp (use HH:MM:SS).';
  if (end === null || !Number.isFinite(end)) return 'End time is not a valid timestamp (use HH:MM:SS).';
  if (start < 0) return 'Start time cannot be negative.';
  if (end <= start) return 'End time must be after the start time.';
  if (end - start < MIN_SEGMENT_SECONDS) return `The segment must be at least ${MIN_SEGMENT_SECONDS} s long.`;
  if (duration !== undefined && Number.isFinite(duration) && duration > 0) {
    // YouTube durations carry sub-millisecond noise; allow 1 ms of tolerance at the end.
    if (start >= duration) return 'Start time is beyond the end of the video.';
    if (end > duration + 0.001) return 'End time is beyond the end of the video.';
  }
  return null;
}

export function sameBounds(a: SegmentBounds, b: SegmentBounds): boolean {
  return Math.abs(a.start - b.start) < 0.0005 && Math.abs(a.end - b.end) < 0.0005;
}
