/** Timestamp utilities. All times are seconds (floating point) unless suffixed with `Ms`. */

const TIMESTAMP_RE = /^(?:(?:(\d+):)?(\d{1,2}):)?(\d{1,2})(?:[.,](\d{1,3}))?$/;

/**
 * Parses `HH:MM:SS` and the shorter forms people type: `MM:SS`, `SS`. A fractional part
 * (`1:23.5`) is accepted; segment fields then round it to whole seconds.
 * Minutes and seconds must be < 60 when a larger unit is present. Returns null when invalid.
 */
export function parseTimestamp(input: string): number | null {
  const m = TIMESTAMP_RE.exec(input.trim());
  if (!m) return null;
  const [, h, min, s, frac] = m;
  const hours = h ? Number(h) : 0;
  const minutes = min ? Number(min) : 0;
  const seconds = Number(s);
  if (min !== undefined && seconds >= 60) return null;
  if (h !== undefined && minutes >= 60) return null;
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

export type Rounding = 'nearest' | 'floor' | 'ceil';

/**
 * Whole seconds for segment boundaries. Starts round down and ends round up, so rounding
 * never clips the beginning or end of a sentence.
 */
export function toWholeSeconds(seconds: number, rounding: Rounding = 'nearest'): number {
  // Absorb float noise (e.g. 4.0000001 must not ceil to 5).
  const s = Math.round(seconds * 1000) / 1000;
  return rounding === 'floor' ? Math.floor(s) : rounding === 'ceil' ? Math.ceil(s) : Math.round(s);
}

/** Formats seconds as `HH:MM:SS`, rounding to whole seconds. */
export function formatTimestamp(seconds: number, rounding: Rounding = 'nearest'): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00';
  const totalS = toWholeSeconds(seconds, rounding);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor(totalS / 60) % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(totalS % 60, 2)}`;
}

/** Compact clock for display: `1:05`, `1:02:03`; with `withMs`, `1:05.250`. */
export function formatClock(seconds: number, withMs = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = withMs ? Math.round(seconds * 1000) : Math.floor(seconds) * 1000;
  const totalS = Math.floor(totalMs / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor(totalS / 60) % 60;
  const base = h > 0 ? `${h}:${pad(m, 2)}:${pad(totalS % 60, 2)}` : `${m}:${pad(totalS % 60, 2)}`;
  return withMs ? `${base}.${pad(totalMs % 1000, 3)}` : base;
}

/** Human length of a segment: `3.25 s`, `1 min 4.0 s`. */
export function formatSegmentLength(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const m = Math.floor(seconds / 60);
  return `${m} min ${(seconds - m * 60).toFixed(1)} s`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}
