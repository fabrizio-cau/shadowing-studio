import { useEffect, useState } from 'react';
import { formatClock, formatSegmentLength } from '../../shared/time';
import { watchUrl, type Recording, type Segment } from '../../shared/types';
import type { AttemptPlayer } from '../hooks';
import { Card, ConfirmButton, Empty, Icon } from './ui';

const formatShortDateTime = (epochMs: number) => new Date(epochMs).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

export interface RecordingsViewProps {
  segment: Segment | null;
  recordings: Recording[];
  player: AttemptPlayer;
  canControlVideo: boolean;
  busy: boolean;
  onPlayOriginal: () => void;
  onDelete: (recording: Recording) => void;
  onUpdate: (recording: Recording, patch: { name?: string; notes?: string }) => void;
  onExport: (recordings: Recording[]) => void;
  onGoToPractice: () => void;
}

/** Laid out like the Library: section titles, a grey header row and compact rows with actions on the right. */
export function RecordingsView(p: RecordingsViewProps) {
  // The attempt the user last interacted with; until then, the one playing.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ?? p.player.currentId;
  if (!p.segment) {
    return (
      <Card>
        <Empty
          title="No segment selected"
          action={
            <button type="button" className="btn" onClick={p.onGoToPractice}>
              Go to Practice
            </button>
          }
        >
          Select a segment and record an attempt; your attempts appear here. Saved segments are in the Library.
        </Empty>
      </Card>
    );
  }
  const seg = p.segment;
  const n = p.recordings.length;
  return (
    <>
      <div className="group">
        <h3 className="group-title">Segment</h3>
        <div className="list">
          <div className="video-head">
            <a className="grow" href={watchUrl(seg.videoId, seg.start)} target="_blank" rel="noreferrer" title="Open on YouTube">
              {seg.videoTitle || seg.videoId}
            </a>
            <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => p.onExport(p.recordings)} disabled={n === 0} aria-label="Export all attempts" title="Export all attempts">
              <Icon name="download" />
            </button>
          </div>
          <div className="list-item">
            <div className="row nowrap">
              <div className="grow">
                <div className="item-title">
                  <span className="seg-num">#{seg.number}</span>
                  <span className="mono">
                    {formatClock(seg.start)} – {formatClock(seg.end)}
                  </span>
                </div>
                <div className="subtle">
                  {formatSegmentLength(seg.end - seg.start)} · {n} attempt{n === 1 ? '' : 's'} · {seg.language || 'Unsorted'}
                </div>
              </div>
              <button type="button" className="btn btn-sm btn-primary" onClick={p.onPlayOriginal} disabled={!p.canControlVideo || p.busy} title={p.canControlVideo ? undefined : 'Open this video to play the original'}>
                <Icon name="play" /> Play original
              </button>
            </div>
            {!p.canControlVideo && <p className="hint">Open this segment's video to play the original.</p>}
          </div>
        </div>
      </div>

      {p.player.error && <p className="error-text">{p.player.error}</p>}

      <div className="group">
        <h3 className="group-title">Attempts</h3>
        {n === 0 ? (
          <Card>
            <Empty title="No attempts yet">Record an attempt in the Practice tab. Each attempt is kept separately.</Empty>
          </Card>
        ) : (
          <div className="list" role="list" aria-label="Attempts">
            {[...p.recordings]
              .sort((a, b) => b.attempt - a.attempt)
              .map((r) => (
                <AttemptRow key={r.id} recording={r} {...p} selected={selected === r.id} onSelect={() => setSelectedId(r.id)} />
              ))}
          </div>
        )}
      </div>
    </>
  );
}

function AttemptRow({ recording: r, player, busy, onDelete, onUpdate, onExport, selected, onSelect }: RecordingsViewProps & { recording: Recording; selected: boolean; onSelect: () => void }) {
  const [name, setName] = useState(r.name);
  const [notes, setNotes] = useState(r.notes);
  const [showNotes, setShowNotes] = useState(!!r.notes);
  useEffect(() => setName(r.name), [r.name]);
  useEffect(() => setNotes(r.notes), [r.notes]);

  const isCurrent = player.currentId === r.id;
  const isPlaying = isCurrent && player.playing;
  const duration = r.durationMs / 1000;
  const position = isCurrent ? Math.min(player.position, duration) : 0;
  const title = `Attempt ${r.attempt}`;

  return (
    // Any interaction inside the row (play, name, notes, export, delete) makes it the selected attempt.
    <div role="listitem" className={`list-item ${selected ? 'selected' : ''}`} onPointerDown={onSelect} onFocus={onSelect}>
      <div className="row nowrap">
        <div className="grow">
          <div className="item-title attempt-title">
            <span className="seg-num">#{r.attempt}</span>
            <input
              className="name-input"
              value={name}
              placeholder="Add a name…"
              aria-label={`Name of ${title}`}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name !== r.name && onUpdate(r, { name: name.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </div>
          <div className="subtle attempt-meta">
            <span>{formatShortDateTime(r.createdAt)}</span>
            <span className="mono">{formatClock(duration)}</span>
            {r.recovered && <span>recovered</span>}
          </div>
        </div>
        <button type="button" className="btn btn-sm btn-primary btn-play" onClick={() => (isPlaying ? player.pause() : player.play(r))} disabled={busy} aria-label={isPlaying ? `Pause ${title}` : `Play ${title}`}>
          <Icon name={isPlaying ? 'pause' : 'play'} /> {isPlaying ? 'Pause' : 'Play'}
        </button>
        <button type="button" className={`btn btn-sm btn-ghost btn-icon ${showNotes ? 'active' : ''}`} onClick={() => setShowNotes((v) => !v)} aria-expanded={showNotes} aria-label="Notes" title="Notes">
          <Icon name="notes" />
        </button>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => onExport([r])} aria-label={`Export ${title}`} title="Export">
          <Icon name="download" />
        </button>
        <ConfirmButton small label={`Delete ${title}`} confirmLabel="Delete" onConfirm={() => onDelete(r)} disabled={busy} />
      </div>
      {isCurrent && duration > 0 && (
        <div className="row nowrap">
          <div className="progress grow" aria-hidden>
            <span style={{ width: `${(position / duration) * 100}%` }} />
          </div>
          <span className="mono subtle">
            {formatClock(position)} / {formatClock(duration)}
          </span>
        </div>
      )}
      {showNotes && (
        <textarea
          className="input"
          value={notes}
          placeholder="What to improve next time…"
          aria-label={`Notes for ${title}`}
          maxLength={2000}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== r.notes && onUpdate(r, { notes })}
        />
      )}
    </div>
  );
}
