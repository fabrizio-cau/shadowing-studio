import { describe, expect, it } from 'vitest';
import { dedupePaths, exportPath, extensionForMime, sanitizeFilePart } from '../src/shared/filename';
import type { Recording, Segment } from '../src/shared/types';
import { planExport } from '../src/sidepanel/export';

describe('sanitizeFilePart', () => {
  it('removes characters that are invalid in file names', () => {
    expect(sanitizeFilePart('a<b>c:d"e/f\\g|h?i*j')).toBe('a b c d e f g h i j');
    expect(sanitizeFilePart('tab\there\nnewline')).toBe('tab here newline');
  });

  it('trims dots and spaces, which Chrome rejects at the ends', () => {
    expect(sanitizeFilePart('  ..hidden...  ')).toBe('hidden');
  });

  it('falls back for empty results and prefixes reserved Windows names', () => {
    expect(sanitizeFilePart('???')).toBe('Untitled');
    expect(sanitizeFilePart('', 60, 'x')).toBe('x');
    expect(sanitizeFilePart('CON')).toBe('_CON');
    expect(sanitizeFilePart('lpt1')).toBe('_lpt1');
  });

  it('limits length', () => {
    expect(sanitizeFilePart('a'.repeat(200), 40)).toHaveLength(40);
  });

  it('keeps non-Latin text', () => {
    expect(sanitizeFilePart('日本語のニュース')).toBe('日本語のニュース');
  });
});

describe('export naming', () => {
  const createdAt = new Date(2026, 10, 6, 14, 3, 9).getTime();

  it('builds the folder structure and descriptive name', () => {
    expect(
      exportPath({ language: 'English', videoTitle: 'My Talk: Part 1', videoId: 'abcdefghijk', segmentNumber: 1, attempt: 2, createdAt, mimeType: 'audio/webm;codecs=opus' }),
    ).toBe('Shadowing Studio/English/My Talk Part 1/2026-11-06_14-03-09_My-Talk-Part-1_Segment01_Attempt02.webm');
  });

  it('uses the video id when the title is missing', () => {
    expect(exportPath({ language: '', videoTitle: '', videoId: 'abcdefghijk', segmentNumber: 12, attempt: 3, createdAt, mimeType: 'audio/ogg' })).toBe(
      'Shadowing Studio/Unsorted/abcdefghijk/2026-11-06_14-03-09_abcdefghijk_Segment12_Attempt03.ogg',
    );
  });

  it('maps MIME types to extensions', () => {
    expect(extensionForMime('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionForMime('audio/mp4')).toBe('m4a');
    expect(extensionForMime('application/x-unknown')).toBe('bin');
  });

  it('dedupes clashing paths case-insensitively', () => {
    expect(dedupePaths(['a/b.webm', 'a/B.webm', 'a/b.webm', 'a/c'])).toEqual(['a/b.webm', 'a/B (2).webm', 'a/b (3).webm', 'a/c']);
  });
});

describe('planExport', () => {
  const segment: Segment = { id: 's1', videoId: 'abcdefghijk', videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk', videoTitle: 'Video', language: 'Spanish', start: 1, end: 3.5, number: 1, nextAttempt: 3, createdAt: 0, updatedAt: 0 };
  const rec = (attempt: number): Recording => ({ id: `r${attempt}`, segmentId: 's1', attempt, createdAt: new Date(2026, 0, 1, 10, 0, attempt).getTime(), durationMs: 2500, mimeType: 'audio/webm', blob: new Blob(['x']), name: attempt === 1 ? 'first' : '', notes: '' });

  it('plans one file per recording without info for single exports', () => {
    const files = planExport([{ segment, recording: rec(1) }], false);
    expect(files).toHaveLength(1);
    expect(files[0].path).toMatch(/^Shadowing Studio\/Spanish\/Video\/2026-01-01_10-00-01_Video_Segment01_Attempt01\.webm$/);
  });

  it('adds an info.json describing the attempts for batch exports', async () => {
    const files = planExport([{ segment, recording: rec(1) }, { segment, recording: rec(2) }], true, Date.UTC(2026, 0, 2));
    expect(files).toHaveLength(3);
    const info = files.find((f) => f.path.endsWith('_info.json'))!;
    const json = JSON.parse(await info.blob.text());
    expect(json.video.id).toBe('abcdefghijk');
    expect(json.segments[0].start).toBe('00:00:01.000');
    expect(json.segments[0].attempts.map((a: { attempt: number }) => a.attempt)).toEqual([1, 2]);
    expect(json.segments[0].attempts[0].name).toBe('first');
    expect(json.segments[0].attempts[1].file).toBe(files[1].path.split('/').pop());
  });
});
