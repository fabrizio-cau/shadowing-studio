import { useEffect, useState } from 'react';
import { formatClock } from '../../shared/time';
import type { Recording, Segment } from '../../shared/types';
import type { AttemptPlayer } from '../hooks';
import { Card, ConfirmButton, Empty, formatBytes, formatDateTime, Icon } from './ui';

export interface RecordingsViewProps {
  segment: Segment | null;
  recordings: Recording[];
  player: AttemptPlayer;
  highlightId: string | null;
  canControlVideo: boolean;
  busy: boolean;
  onPlayOriginal: () => void;
  onDelete: (recording: Recording) => void;
  onUpdate: (recording: Recording, patch: { name?: string; notes?: string }) => void;
  onExport: (recordings: Recording[]) => void;
  onGoToPractice: () => void;
}

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
  return (
    <>
      <Card
        title={`Segment #${seg.number}`}
        actions={
          <span className="mono subtle" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {formatClock(seg.start)} – {formatClock(seg.end)}
          </span>
        }
      >
        <p className="hint" style={{ margin: 0 }}>
          {seg.videoTitle || seg.videoId} · {seg.language}
        </p>
        <div className="row">
          <button type="button" className="btn" onClick={p.onPlayOriginal} disabled={!p.canControlVideo || p.busy} title={p.canControlVideo ? undefined : 'Open this video to play the original'}>
            <Icon name="play" /> Play original
          </button>
          <span className="grow" />
          <button type="button" className="btn" onClick={() => p.onExport(p.recordings)} disabled={p.recordings.length === 0}>
            <Icon name="download" /> Export all
          </button>
        </div>
        {!p.canControlVideo && <p className="hint">Open this segment's video to play the original.</p>}
      </Card>

      {p.player.error && <p className="error-text">{p.player.error}</p>}

      {p.recordings.length === 0 ? (
        <Card>
          <Empty title="No attempts yet">Record an attempt in the Practice tab. Each attempt is kept separately.</Empty>
        </Card>
      ) : (
        <div className="list" role="list" aria-label="Attempts">
          {[...p.recordings].reverse().map((r) => (
            <AttemptRow key={r.id} recording={r} {...p} selected={selected === r.id} onSelect={() => setSelectedId(r.id)} />
          ))}
        </div>
      )}
    </>
  );
}

function AttemptRow({ recording: r, player, highlightId, busy, onDelete, onUpdate, onExport, selected, onSelect }: RecordingsViewProps & { recording: Recording; selected: boolean; onSelect: () => void }) {
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
    <div role="listitem" className={`list-item ${highlightId === r.id ? 'highlight' : ''} ${selected ? 'selected' : ''}`} onPointerDown={onSelect} onFocus={onSelect}>
      <div className="row nowrap">
        <button type="button" className={`btn btn-icon ${isPlaying ? 'active' : ''}`} onClick={() => (isPlaying ? player.pause() : player.play(r))} disabled={busy} aria-label={isPlaying ? `Pause ${title}` : `Play ${title}`}>
          <Icon name={isPlaying ? 'pause' : 'play'} />
        </button>
        <div className="grow">
          <input
            className="name-input"
            value={name}
            placeholder={title}
            aria-label={`Name of ${title}`}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== r.name && onUpdate(r, { name: name.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <div className="subtle">
            {name ? `${title} · ` : ''}
            {formatDateTime(r.createdAt)} · <span className="mono">{isCurrent ? `${formatClock(position)} / ` : ''}{formatClock(duration)}</span> · {formatBytes(r.blob.size)}
            {r.recovered ? ' · recovered' : ''}
          </div>
        </div>
      </div>
      {isCurrent && duration > 0 && (
        <div className="progress" aria-hidden>
          <span style={{ width: `${(position / duration) * 100}%` }} />
        </div>
      )}
      <div className="row">
        <button type="button" className={`btn btn-sm btn-ghost ${showNotes ? 'active' : ''}`} onClick={() => setShowNotes((v) => !v)} aria-expanded={showNotes}>
          <Icon name="notes" /> Notes
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => onExport([r])} aria-label={`Export ${title}`} title="Export">
          <Icon name="download" />
        </button>
        <ConfirmButton small label={`Delete ${title}`} confirmLabel="Delete" onConfirm={() => onDelete(r)} disabled={busy} />
      </div>
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
