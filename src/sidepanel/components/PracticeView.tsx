import { useEffect, useState } from 'react';
import type { PlayerState } from '../../shared/messages';
import { formatClock, formatSegmentLength, formatTimestamp, parseTimestamp, type Rounding } from '../../shared/time';
import type { PracticeMode, Segment } from '../../shared/types';
import type { MicPermission } from '../microphone';
import type { Connection } from '../player';
import type { RecorderStatus } from '../recorder';
import { Banner, Card, Empty, Icon, Segmented } from './ui';

export type RepeatPhase = 'idle' | 'listening' | 'your-turn' | 'done';
export type SaveState = 'new' | 'saved' | 'modified' | 'modified-new';

export interface PracticeViewProps {
  connection: Connection;
  player: PlayerState | null;
  onReloadTab: () => void;
  onOpenYouTube: () => void;

  language: string;
  onLanguageChange: (language: string) => void;

  startText: string;
  endText: string;
  onStartChange: (text: string) => void;
  onEndChange: (text: string) => void;
  onSetStartNow: () => void;
  onSetEndNow: () => void;
  segmentError: string | null;
  segmentLength: number | null;
  saveState: SaveState;
  savedSegment: Segment | null;
  attemptCount: number;
  onSave: () => void;
  onReset: () => void;
  videoSegments: Segment[];
  onPickSegment: (segment: Segment) => void;

  onPreview: () => void;
  onPlayPause: () => void;
  onRestart: () => void;
  onToggleLoop: () => void;

  mode: PracticeMode;
  onModeChange: (mode: PracticeMode) => void;
  autoStop: boolean;
  onAutoStopChange: (value: boolean) => void;

  mic: MicPermission;
  onMicSetup: () => void;
  recorderStatus: RecorderStatus;
  elapsedMs: number;
  onRecord: () => void;
  onStop: () => void;
  phase: RepeatPhase;
  onListen: () => void;
  onShowRecordings: () => void;
}

export function PracticeView(p: PracticeViewProps) {
  const ready = p.connection.kind === 'connected' && p.player?.status.kind === 'ready';
  return (
    <>
      <VideoCard {...p} />
      {ready && p.player && (
        <>
          <SegmentCard {...p} player={p.player} />
          <PlaybackCard {...p} player={p.player} />
          <RecordCard {...p} />
        </>
      )}
    </>
  );
}

function VideoCard(p: PracticeViewProps) {
  const { connection: c, player } = p;
  if (c.kind === 'connecting') return <Card><p className="hint">Connecting to the current tab…</p></Card>;
  if (c.kind === 'no-tab' || c.kind === 'not-youtube') {
    return (
      <Card>
        <Empty
          title="Open a YouTube video"
          action={
            <button type="button" className="btn btn-primary" onClick={p.onOpenYouTube}>
              <Icon name="external" /> Go to YouTube
            </button>
          }
        >
          Shadowing Studio works on regular YouTube watch pages. Saved segments are in the Library.
        </Empty>
      </Card>
    );
  }
  if (c.kind === 'needs-reload') {
    return (
      <Card>
        <Empty
          title="Reload this tab"
          action={
            <button type="button" className="btn btn-primary" onClick={p.onReloadTab}>
              <Icon name="reload" /> Reload tab
            </button>
          }
        >
          This tab was opened before Shadowing Studio was installed or updated, so it cannot be controlled yet.
        </Empty>
      </Card>
    );
  }
  if (!player) return <Card><p className="hint">Waiting for the player…</p></Card>;
  const s = player.status;
  if (s.kind === 'not-watch') {
    return (
      <Card>
        <Empty title="Pick a video">Open any video on YouTube to start practising.</Empty>
      </Card>
    );
  }
  if (s.kind === 'unsupported') {
    return (
      <Card>
        <Empty title="Not supported">{s.reason}</Empty>
      </Card>
    );
  }
  return (
    <Card>
      <div className="row nowrap" style={{ alignItems: 'flex-start' }}>
        <h1 className="video-title grow" title={player.title}>
          {player.title || 'YouTube video'}
        </h1>
      </div>
      {s.kind === 'waiting' ? (
        <p className="hint">Waiting for the video to load…</p>
      ) : (
        <div className="row">
          <span className="mono muted">
            {formatClock(player.currentTime)} / {formatClock(player.duration)}
          </span>
          {player.playbackRate !== 1 && <span className="chip">{player.playbackRate}×</span>}
          {player.buffering && <span className="chip warn">Buffering</span>}
          {player.isAd && <span className="chip warn">Ad playing — loop paused</span>}
          {player.loopMode === 'loop' && (
            <span className="chip accent">
              <Icon name="loop" /> Looping
            </span>
          )}
        </div>
      )}
      <label className="field">
        <span className="field-label">Language</span>
        <input
          className="input"
          value={p.language}
          onChange={(e) => p.onLanguageChange(e.target.value)}
          placeholder="e.g. Spanish"
          autoComplete="off"
          maxLength={40}
        />
      </label>
    </Card>
  );
}

function TimeField({ label, value, onCommit, onSetNow, invalid, rounding }: { label: string; value: string; onCommit: (v: string) => void; onSetNow: () => void; invalid: boolean; rounding: Rounding }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const parsed = parseTimestamp(text);
    // Normalise valid input to HH:MM:SS; keep invalid text so the error can be fixed in place.
    const normalised = parsed === null ? text.trim() : formatTimestamp(parsed, rounding);
    setText(normalised);
    if (normalised !== value) onCommit(normalised);
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="time-input">
        <input
          className="input mono"
          value={text}
          placeholder="00:00:00"
          spellCheck={false}
          inputMode="decimal"
          aria-invalid={invalid}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setText(value);
          }}
        />
        <button type="button" className="btn btn-icon" onClick={onSetNow} title={`Set ${label.toLowerCase()} to the current position`} aria-label={`Set ${label.toLowerCase()} to the current position`}>
          <Icon name="target" />
        </button>
      </span>
    </label>
  );
}

function SegmentCard(p: PracticeViewProps & { player: PlayerState }) {
  const empty = !p.startText && !p.endText;
  const busy = p.recorderStatus !== 'idle';
  return (
    <Card
      title="Segment"
      actions={
        p.saveState === 'saved' && p.savedSegment ? (
          <span className="chip ok">
            Saved · #{p.savedSegment.number}
          </span>
        ) : p.saveState === 'new' && p.segmentLength ? (
          <span className="chip">Not saved</span>
        ) : p.saveState !== 'new' ? (
          <span className="chip warn">Edited</span>
        ) : null
      }
    >
      <div className="time-grid">
        <TimeField label="Start" value={p.startText} onCommit={p.onStartChange} onSetNow={p.onSetStartNow} invalid={!!p.segmentError && !empty} rounding="floor" />
        <TimeField label="End" value={p.endText} onCommit={p.onEndChange} onSetNow={p.onSetEndNow} invalid={!!p.segmentError && !empty} rounding="ceil" />
      </div>
      {empty ? (
        <p className="hint">
          Play the video and press <Icon name="target" /> at the start and the end of a sentence, or type times like <span className="mono">00:01:23</span>.
        </p>
      ) : p.segmentError ? (
        <p className="error-text">{p.segmentError}</p>
      ) : (
        <p className="hint">
          Length: <strong>{formatSegmentLength(p.segmentLength ?? 0)}</strong>
        </p>
      )}
      {p.saveState === 'modified-new' && (
        <p className="hint">This segment already has {p.attemptCount} attempt{p.attemptCount === 1 ? '' : 's'}. Recording with new times will create a new segment.</p>
      )}
      <div className="row">
        <button type="button" className="btn" onClick={p.onPreview} disabled={!p.segmentLength || busy}>
          <Icon name="play" /> Preview
        </button>
        <button type="button" className="btn" onClick={p.onSave} disabled={!p.segmentLength || p.saveState === 'saved' || busy}>
          <Icon name="save" /> {p.saveState === 'modified' ? 'Update' : 'Save'}
        </button>
        <span className="grow" />
        <button type="button" className="btn" onClick={p.onReset} disabled={empty || busy} title="Clear the times to start a new segment">
          <Icon name="plus" /> New
        </button>
      </div>
      {p.videoSegments.length > 0 && (
        <div className="group">
          <span className="field-label">Saved in this video</span>
          <div className="seg-chips">
            {p.videoSegments.map((s) => (
              <button key={s.id} type="button" className="seg-chip mono" aria-pressed={p.savedSegment?.id === s.id} onClick={() => p.onPickSegment(s)} disabled={busy}>
                #{s.number} {formatClock(s.start)}–{formatClock(s.end)}
              </button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function PlaybackCard(p: PracticeViewProps & { player: PlayerState }) {
  const { player } = p;
  const has = !!p.segmentLength;
  const looping = player.loopMode === 'loop';
  let progress = 0;
  if (has && player.segment) {
    const { start, end } = player.segment;
    progress = Math.min(1, Math.max(0, (player.currentTime - start) / (end - start)));
  }
  return (
    <Card title="Playback">
      {has && (
        <div className="progress" aria-hidden>
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <div className="row nowrap">
        <button type="button" className="btn btn-icon" onClick={p.onRestart} disabled={!has} title="Back to segment start" aria-label="Back to segment start">
          <Icon name="rewind" />
        </button>
        <button type="button" className="btn btn-icon" onClick={p.onPlayPause} title={player.paused ? 'Play' : 'Pause'} aria-label={player.paused ? 'Play' : 'Pause'}>
          <Icon name={player.paused ? 'play' : 'pause'} />
        </button>
        <span className="grow" />
        <label className="switch">
          <input type="checkbox" role="switch" checked={looping} onChange={p.onToggleLoop} disabled={!has} />
          Loop segment
        </label>
      </div>
    </Card>
  );
}

function RecordCard(p: PracticeViewProps) {
  const recording = p.recorderStatus === 'recording';
  const busy = p.recorderStatus === 'starting' || p.recorderStatus === 'stopping';
  const canRecord = !!p.segmentLength && !busy;
  return (
    <Card title="Practice">
      <Segmented<PracticeMode>
        label="Practice mode"
        value={p.mode}
        disabled={p.recorderStatus !== 'idle'}
        onChange={p.onModeChange}
        options={[
          { value: 'shadowing', label: 'Shadowing' },
          { value: 'repeat', label: 'Listen & repeat' },
        ]}
      />
      <p className="hint">
        {p.mode === 'shadowing'
          ? 'Speak along with the video while the segment loops. Use headphones so only your voice is recorded.'
          : 'Listen to the segment first. It pauses at the end, then you record your imitation.'}
      </p>

      <MicStatus mic={p.mic} onSetup={p.onMicSetup} />

      {recording && (
        <div className="row" aria-live="polite">
          <span className="rec-dot" aria-hidden />
          <span className="timer">{formatClock(p.elapsedMs / 1000, true).slice(0, -2)}</span>
          <span className="subtle">Recording your microphone</span>
        </div>
      )}

      {p.mode === 'shadowing' ? (
        <>
          <div className="row nowrap">
            {recording ? (
              <button type="button" className="btn btn-record recording" onClick={p.onStop}>
                <Icon name="stop" /> Stop recording
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-record" onClick={p.onRecord} disabled={!canRecord}>
                <Icon name="mic" /> {busy ? (p.recorderStatus === 'starting' ? 'Starting…' : 'Saving…') : 'Record'}
              </button>
            )}
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={p.autoStop} onChange={(e) => p.onAutoStopChange(e.target.checked)} disabled={p.recorderStatus !== 'idle'} />
            Stop automatically at the end of the segment
          </label>
        </>
      ) : (
        <RepeatControls {...p} canRecord={canRecord} busy={busy} recording={recording} />
      )}

      {p.attemptCount > 0 && (
        <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={p.onShowRecordings}>
          {p.attemptCount} attempt{p.attemptCount === 1 ? '' : 's'} for this segment →
        </button>
      )}
    </Card>
  );
}

function RepeatControls(p: PracticeViewProps & { canRecord: boolean; busy: boolean; recording: boolean }) {
  if (p.recording) {
    return (
      <div className="row nowrap">
        <button type="button" className="btn btn-record recording" onClick={p.onStop}>
          <Icon name="stop" /> Stop recording
        </button>
      </div>
    );
  }
  const step = p.phase === 'listening' ? 'Listening…' : p.phase === 'your-turn' ? 'Your turn — record your imitation.' : p.phase === 'done' ? 'Saved. Listen again or record another attempt.' : 'Step 1: listen. Step 2: record.';
  return (
    <>
      <p className="hint" aria-live="polite">
        <strong>{step}</strong>
      </p>
      <div className="row nowrap">
        <button type="button" className={`btn btn-lg grow ${p.phase === 'your-turn' ? '' : 'btn-primary'}`} onClick={p.onListen} disabled={!p.segmentLength || p.busy || p.phase === 'listening'}>
          <Icon name="ear" /> {p.phase === 'idle' ? 'Listen' : 'Listen again'}
        </button>
        <button type="button" className={`btn btn-lg grow ${p.phase === 'your-turn' ? 'btn-primary' : ''}`} onClick={p.onRecord} disabled={!p.canRecord || p.phase === 'listening'}>
          <Icon name="mic" /> {p.busy ? (p.recorderStatus === 'starting' ? 'Starting…' : 'Saving…') : 'Record'}
        </button>
      </div>
    </>
  );
}

function MicStatus({ mic, onSetup }: { mic: MicPermission; onSetup: () => void }) {
  if (mic === 'granted') {
    return (
      <div className="row">
        <span className="chip ok">
          <span className="dot" /> Microphone ready
        </span>
      </div>
    );
  }
  if (mic === 'denied') {
    return (
      <Banner tone="warn" action={<button type="button" className="btn btn-sm" onClick={onSetup}>Open settings</button>}>
        Microphone access is blocked for Shadowing Studio.
      </Banner>
    );
  }
  return (
    <div className="row">
      <span className="chip">
        <span className="dot" /> Microphone not enabled yet
      </span>
      <button type="button" className="btn btn-sm" onClick={onSetup}>
        Enable microphone
      </button>
    </div>
  );
}
