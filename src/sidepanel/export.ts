import { dedupePaths, exportFolder, exportPath, fileTimestamp, sanitizeFilePart } from '../shared/filename';
import { formatTimestamp } from '../shared/time';
import type { Recording, Segment } from '../shared/types';

export interface ExportItem {
  segment: Segment;
  recording: Recording;
}

export interface PlannedFile {
  path: string;
  blob: Blob;
}

/**
 * Plans the files of an export: one audio file per recording and, for multi-recording exports,
 * an `info.json` per video folder describing segments and attempts. Pure, so it is testable.
 */
export function planExport(items: ExportItem[], includeInfo: boolean, now = Date.now()): PlannedFile[] {
  const audio = items.map(({ segment, recording }) => ({
    path: exportPath({
      language: segment.language,
      videoTitle: segment.videoTitle,
      videoId: segment.videoId,
      segmentNumber: segment.number,
      attempt: recording.attempt,
      createdAt: recording.createdAt,
      mimeType: recording.mimeType,
    }),
    blob: recording.blob,
  }));
  const files: PlannedFile[] = [...audio];

  if (includeInfo) {
    const byFolder = new Map<string, ExportItem[]>();
    for (const item of items) {
      const folder = exportFolder(item.segment.language, item.segment.videoTitle, item.segment.videoId);
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), item]);
    }
    for (const [folder, group] of byFolder) {
      const segments = new Map<string, Segment>(group.map((g) => [g.segment.id, g.segment]));
      const info = {
        exportedAt: new Date(now).toISOString(),
        video: { id: group[0].segment.videoId, title: group[0].segment.videoTitle, url: group[0].segment.videoUrl },
        language: group[0].segment.language,
        segments: [...segments.values()].map((s) => ({
          number: s.number,
          start: formatTimestamp(s.start),
          end: formatTimestamp(s.end),
          lengthSeconds: Number((s.end - s.start).toFixed(3)),
          attempts: group
            .filter((g) => g.segment.id === s.id)
            .map((g) => ({
              attempt: g.recording.attempt,
              name: g.recording.name,
              notes: g.recording.notes,
              recordedAt: new Date(g.recording.createdAt).toISOString(),
              durationSeconds: Number((g.recording.durationMs / 1000).toFixed(3)),
              file: audio[items.indexOf(g)].path.split('/').pop(),
            })),
        })),
      };
      files.push({
        path: `${folder}/${fileTimestamp(now)}_${sanitizeFilePart(group[0].segment.videoTitle || group[0].segment.videoId, 40).replace(/ /g, '-')}_info.json`,
        blob: new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' }),
      });
    }
  }

  const paths = dedupePaths(files.map((f) => f.path));
  return files.map((f, i) => ({ ...f, path: paths[i] }));
}

export interface ExportResult {
  saved: number;
  failed: Array<{ path: string; error: string }>;
}

/**
 * Saves files under the user's Downloads folder with chrome.downloads. Blob URLs are revoked
 * once Chrome reports the download finished or failed.
 */
export async function downloadFiles(files: PlannedFile[]): Promise<ExportResult> {
  const result: ExportResult = { saved: 0, failed: [] };
  for (const file of files) {
    const url = URL.createObjectURL(file.blob);
    try {
      const id = await chrome.downloads.download({ url, filename: file.path, conflictAction: 'uniquify', saveAs: false });
      if (id === undefined) throw new Error(chrome.runtime.lastError?.message ?? 'Download was not started.');
      revokeWhenDone(id, url);
      result.saved++;
    } catch (err) {
      URL.revokeObjectURL(url);
      result.failed.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

function revokeWhenDone(id: number, url: string): void {
  const listener = (delta: chrome.downloads.DownloadDelta) => {
    if (delta.id !== id) return;
    const state = delta.state?.current;
    if (state === 'complete' || state === 'interrupted') {
      URL.revokeObjectURL(url);
      chrome.downloads.onChanged.removeListener(listener);
    }
  };
  chrome.downloads.onChanged.addListener(listener);
}

/** Direct download for audio that could not be stored (last resort, never lose a take). */
export function downloadUnsaved(blob: Blob, mimeType: string): Promise<ExportResult> {
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm';
  return downloadFiles([{ path: `Shadowing Studio/Unsaved/${fileTimestamp(Date.now())}_unsaved-recording.${ext}`, blob }]);
}
