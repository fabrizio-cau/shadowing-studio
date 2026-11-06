import { useEffect, useMemo, useState } from 'react';
import { formatClock, formatSegmentLength } from '../../shared/time';
import { watchUrl, type Segment } from '../../shared/types';
import type { ShadowingStore } from '../../storage/db';
import { Banner, Card, ConfirmButton, Empty, formatBytes, Icon } from './ui';

export interface LibraryViewProps {
  store: ShadowingStore;
  /** Bumped by the parent whenever segments or recordings change. */
  version: number;
  currentSegmentId: string | null;
  onResume: (segment: Segment) => void;
  onExport: (segments: Segment[]) => void;
  onDelete: (segment: Segment) => void;
}

/** Segments saved without a language; the same label export folders use. */
const languageLabel = (language: string) => language || 'Unsorted';

/** Alphabetical, ignoring case and accents; segments without a language (Unsorted) always last. */
function byLanguage(a: string, b: string): number {
  if (!a || !b) return Number(!a) - Number(!b);
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

const byTitle = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

interface VideoGroup {
  videoId: string;
  title: string;
  url: string;
  segments: Segment[];
}

export function LibraryView(p: LibraryViewProps) {
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [usage, setUsage] = useState<{ bytes: number; recordings: number; quota?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState('all');
  const [videoId, setVideoId] = useState('all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [segs, c, u] = await Promise.all([p.store.listSegments(), p.store.countRecordingsBySegment(), p.store.usage()]);
        const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
        if (cancelled) return;
        setSegments(segs);
        setCounts(c);
        setUsage({ ...u, quota: estimate?.quota });
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [p.store, p.version]);

  const languages = useMemo(() => [...new Set((segments ?? []).map((s) => s.language))].sort(byLanguage), [segments]);

  const tree = useMemo(() => {
    const byLang = new Map<string, Map<string, VideoGroup>>();
    for (const s of segments ?? []) {
      if (language !== 'all' && s.language !== language) continue;
      if (videoId !== 'all' && s.videoId !== videoId) continue;
      const videos = byLang.get(s.language) ?? new Map<string, VideoGroup>();
      byLang.set(s.language, videos);
      const g = videos.get(s.videoId) ?? { videoId: s.videoId, title: s.videoTitle || s.videoId, url: s.videoUrl, segments: [] };
      g.segments.push(s);
      videos.set(s.videoId, g);
    }
    return [...byLang.entries()]
      .sort(([a], [b]) => byLanguage(a, b))
      .map(([lang, videos]) => ({
        language: lang,
        videos: [...videos.values()]
          .map((v) => ({ ...v, segments: v.segments.sort((a, b) => a.number - b.number) }))
          .sort((a, b) => byTitle(a.title, b.title)),
      }));
  }, [segments, language, videoId]);

  const videoOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of segments ?? []) if (language === 'all' || s.language === language) m.set(s.videoId, s.videoTitle || s.videoId);
    return [...m.entries()].sort((a, b) => byTitle(a[1], b[1]));
  }, [segments, language]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!segments) return <p className="hint">Loading library…</p>;
  if (segments.length === 0) {
    return (
      <Card>
        <Empty title="Your library is empty">Segments you save or record are kept here, grouped by language and video. Everything is stored on this computer.</Empty>
      </Card>
    );
  }

  return (
    <>
      <div className="row nowrap">
        <label className="field grow">
          <span className="field-label">Language</span>
          <select
            className="input"
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value);
              setVideoId('all');
            }}
          >
            <option value="all">All languages</option>
            {languages.map((l) => (
              <option key={l} value={l}>
                {languageLabel(l)}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span className="field-label">Video</span>
          <select className="input" value={videoId} onChange={(e) => setVideoId(e.target.value)}>
            <option value="all">All videos</option>
            {videoOptions.map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
      </div>

      {tree.map((lang) => (
        <div key={lang.language} className="group">
          <h3 className="group-title">{languageLabel(lang.language)}</h3>
          {lang.videos.map((v) => (
            <div key={v.videoId} className="list">
              <div className="video-head">
                <a className="grow" href={watchUrl(v.videoId)} target="_blank" rel="noreferrer" title="Open on YouTube">
                  {v.title}
                </a>
                <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => p.onExport(v.segments)} aria-label={`Export all recordings of ${v.title}`} title="Export all recordings of this video">
                  <Icon name="download" />
                </button>
              </div>
              {v.segments.map((s) => {
                const n = counts.get(s.id) ?? 0;
                return (
                  <div key={s.id} className={`list-item ${p.currentSegmentId === s.id ? 'highlight' : ''}`}>
                    <div className="row nowrap">
                      <div className="grow">
                        <div className="item-title">
                          <span className="seg-num">#{s.number}</span>
                          <span className="mono">
                            {formatClock(s.start)} – {formatClock(s.end)}
                          </span>
                        </div>
                        <div className="subtle">
                          {formatSegmentLength(s.end - s.start)} · {n} attempt{n === 1 ? '' : 's'} · {new Date(s.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => p.onResume(s)}>
                        Practice
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => p.onExport([s])} disabled={n === 0} aria-label={`Export segment ${s.number}`} title="Export recordings">
                        <Icon name="download" />
                      </button>
                      <ConfirmButton small label={`Delete segment ${s.number} and its recordings`} confirmLabel="Delete" onConfirm={() => p.onDelete(s)} />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}

      {usage && (
        <p className="footer-note">
          {usage.recordings} recording{usage.recordings === 1 ? '' : 's'} · {formatBytes(usage.bytes)} stored locally
          {usage.quota ? ` · ${formatBytes(usage.quota)} available to the browser` : ''}
        </p>
      )}
    </>
  );
}
