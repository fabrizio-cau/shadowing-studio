import { describe, expect, it } from 'vitest';
import { MIN_SEGMENT_SECONDS, sameBounds, validateSegment } from '../src/shared/segment';
import { formatClock, formatSegmentLength, formatTimestamp, parseTimestamp, toWholeSeconds } from '../src/shared/time';

describe('parseTimestamp', () => {
  it.each([
    ['00:00:00.000', 0],
    ['01:02:03.456', 3723.456],
    ['1:02:03.4', 3723.4],
    ['12:34', 754],
    ['2:05.5', 125.5],
    ['45', 45],
    ['7.25', 7.25],
    ['0,5', 0.5],
    ['  00:01:00.000  ', 60],
    ['100:00:00', 360000],
  ])('parses %s', (input, expected) => {
    expect(parseTimestamp(input)).toBeCloseTo(expected, 6);
  });

  it.each(['', 'abc', '1:2:3:4', '-1', '00:60', '01:60:00', '1:2.3456', '1.', '.5', '12:3a', '1:-1'])('rejects %j', (input) => {
    expect(parseTimestamp(input)).toBeNull();
  });

  it('pads milliseconds from the right (".5" = 500 ms)', () => {
    expect(parseTimestamp('00:00:01.5')).toBe(1.5);
    expect(parseTimestamp('00:00:01.05')).toBe(1.05);
  });
});

describe('formatTimestamp', () => {
  it.each([
    [0, '00:00:00'],
    [1.4, '00:00:01'],
    [1.5, '00:00:02'],
    [59.6, '00:01:00'],
    [3723.456, '01:02:03'],
    [360000, '100:00:00'],
  ])('formats %d as HH:MM:SS', (input, expected) => {
    expect(formatTimestamp(input)).toBe(expected);
  });

  it('rounds segment starts down and ends up, so a sentence is never clipped', () => {
    expect(formatTimestamp(83.9, 'floor')).toBe('00:01:23');
    expect(formatTimestamp(83.1, 'ceil')).toBe('00:01:24');
    expect(formatTimestamp(83, 'ceil')).toBe('00:01:23');
    // Float noise must not push an exact second to the next one.
    expect(toWholeSeconds(4.0000001, 'ceil')).toBe(4);
    expect(toWholeSeconds(3.9999999, 'floor')).toBe(4);
  });

  it('handles invalid input', () => {
    expect(formatTimestamp(NaN)).toBe('00:00:00');
    expect(formatTimestamp(-1)).toBe('00:00:00');
    expect(formatTimestamp(Infinity)).toBe('00:00:00');
  });

  it('round-trips whole seconds with parseTimestamp', () => {
    for (const t of [0, 1, 61, 3599, 7322]) {
      expect(parseTimestamp(formatTimestamp(t))).toBe(t);
    }
  });
});

describe('formatClock / formatSegmentLength', () => {
  it('formats compact clocks', () => {
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(65.9)).toBe('1:05');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(5.25, true)).toBe('0:05.250');
    expect(formatClock(NaN)).toBe('0:00');
  });

  it('formats segment lengths', () => {
    expect(formatSegmentLength(3.254)).toBe('3.25 s');
    expect(formatSegmentLength(64)).toBe('1 min 4.0 s');
    expect(formatSegmentLength(0)).toBe('0 s');
  });
});

describe('validateSegment', () => {
  it('accepts a valid segment', () => {
    expect(validateSegment(1, 3, 100)).toBeNull();
    expect(validateSegment(0, 100, 100)).toBeNull();
    expect(validateSegment(1, 3)).toBeNull(); // duration unknown
    expect(validateSegment(1, 3, NaN)).toBeNull();
  });

  it('rejects invalid values', () => {
    expect(validateSegment(null, 3, 100)).toMatch(/Start/);
    expect(validateSegment(1, null, 100)).toMatch(/End/);
    expect(validateSegment(-1, 3, 100)).toMatch(/negative/);
    expect(validateSegment(3, 3, 100)).toMatch(/after/);
    expect(validateSegment(4, 3, 100)).toMatch(/after/);
    expect(validateSegment(1, 1 + MIN_SEGMENT_SECONDS / 2, 100)).toMatch(/at least/);
    expect(validateSegment(100, 101, 100)).toMatch(/beyond/);
    expect(validateSegment(10, 100.5, 100)).toMatch(/End time is beyond/);
  });

  it('tolerates sub-millisecond duration noise at the end', () => {
    expect(validateSegment(90, 100.0005, 100)).toBeNull();
  });

  it('compares bounds at millisecond precision', () => {
    expect(sameBounds({ start: 1, end: 2 }, { start: 1.0001, end: 2 })).toBe(true);
    expect(sameBounds({ start: 1, end: 2 }, { start: 1.001, end: 2 })).toBe(false);
  });
});
