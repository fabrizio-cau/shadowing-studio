const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Makes one path component safe for chrome.downloads on Windows, macOS and Linux:
 * strips reserved and control characters, collapses whitespace, trims dots and spaces
 * (Chrome rejects leading/trailing dots) and limits the length.
 */
export function sanitizeFilePart(input: string, maxLength = 60, fallback = 'Untitled'): string {
  let s = input
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/[​-‏‪-‮﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLength) s = s.slice(0, maxLength);
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

export function extensionForMime(mimeType: string): string {
  switch (mimeType.split(';')[0].trim().toLowerCase()) {
    case 'audio/webm':
    case 'video/webm':
      return 'webm';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
    case 'video/mp4':
      return 'm4a';
    case 'audio/wav':
      return 'wav';
    default:
      return 'bin';
  }
}

/** `2026-11-06_14-03-09` in local time. */
export function fileTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export const EXPORT_ROOT = 'Shadowing Studio';

/** Folder relative to Downloads: `Shadowing Studio/<Language>/<Video title>`. */
export function exportFolder(language: string, videoTitle: string, videoId: string): string {
  return [EXPORT_ROOT, sanitizeFilePart(language, 40, 'Unsorted'), sanitizeFilePart(videoTitle || videoId, 60, videoId)].join('/');
}

export interface ExportNameInput {
  language: string;
  videoTitle: string;
  videoId: string;
  segmentNumber: number;
  attempt: number;
  createdAt: number;
  mimeType: string;
}

/** `Shadowing Studio/English/Video/2026-11-06_14-03-09_Video_Segment01_Attempt01.webm` */
export function exportPath(input: ExportNameInput): string {
  const shortTitle = sanitizeFilePart(input.videoTitle || input.videoId, 40, input.videoId).replace(/ /g, '-');
  const nn = (n: number) => String(n).padStart(2, '0');
  const file = `${fileTimestamp(input.createdAt)}_${shortTitle}_Segment${nn(input.segmentNumber)}_Attempt${nn(input.attempt)}.${extensionForMime(input.mimeType)}`;
  return `${exportFolder(input.language, input.videoTitle, input.videoId)}/${file}`;
}

/**
 * Makes a batch of paths unique (case-insensitively, as on Windows and macOS) by appending
 * ` (2)`, ` (3)`… before the extension. chrome.downloads' `uniquify` covers clashes with files
 * already on disk; this covers clashes inside one export batch.
 */
export function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.map((p) => {
    const dot = p.lastIndexOf('.');
    const [stem, ext] = dot > p.lastIndexOf('/') ? [p.slice(0, dot), p.slice(dot)] : [p, ''];
    let candidate = p;
    for (let i = 2; seen.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}
