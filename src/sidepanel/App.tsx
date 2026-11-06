import fixWebmDuration from 'fix-webm-duration';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { PlayerCommand, PlayerEvent, PlayerState } from '../shared/messages';
import { sameBounds, validateSegment } from '../shared/segment';
import { formatTimestamp, parseTimestamp, toWholeSeconds } from '../shared/time';
import { DEFAULT_SETTINGS, watchUrl, type PracticeMode, type Recording, type Segment, type Settings } from '../shared/types';
import { ShadowingStore, type FixDuration } from '../storage/db';
import { LibraryView } from './components/LibraryView';
import { PracticeView, type RepeatPhase, type SaveState } from './components/PracticeView';
import { RecordingsView } from './components/RecordingsView';
import { Banner, Icon, type BannerTone } from './components/ui';
import { downloadFiles, downloadUnsaved, planExport, type ExportItem } from './export';
import { useAttemptPlayer, useRecordingIndicator, useTicker } from './hooks';
import { openMicSettings, openPermissionPage, watchMicPermission, type MicPermission } from './microphone';
import { PlayerConnection, type Connection } from './player';
import { RecorderError, RecorderService, type RecorderStatus } from './recorder';
import { loadSettings, saveSettings } from './settings';

type Tab = 'practice' | 'recordings' | 'library';

interface Workspace {
  videoId: string | null;
  segmentId: string | null;
  startText: string;
  endText: string;
}

interface Notice {
  tone: BannerTone;
  text: string;
  action?: { label: string; run: () => void };
}

const store = new ShadowingStore();
const fixDuration: FixDuration = (blob, ms) => fixWebmDuration(blob, ms, { logger: false });
/** Crash recovery runs once per panel document (StrictMode mounts effects twice in development). */
let recovery: Promise<Recording[]> | null = null;
const EMPTY_WORKSPACE: Workspace = { videoId: null, segmentId: null, startText: '', endText: '' };

/** `?tabId=N` pins the panel to one tab. Only used when the panel page is opened as a tab by automated tests. */
const fixedTabId = (() => {
  const v = new URLSearchParams(location.search).get('tabId');
  return v && /^\d+$/.test(v) ? Number(v) : undefined;
})();

/** End rounds up so the sentence is not clipped, but never past the end of the video. */
function endTimestamp(time: number, duration: number): string {
  return Number.isFinite(duration) && toWholeSeconds(time, 'ceil') > duration ? formatTimestamp(duration, 'floor') : formatTimestamp(time, 'ceil');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function App() {
  const [tab, setTab] = useState<Tab>('practice');
  const [connection, setConnection] = useState<Connection>({ kind: 'connecting' });
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ws, setWs] = useState<Workspace>(EMPTY_WORKSPACE);
  const [language, setLanguage] = useState(DEFAULT_SETTINGS.language);
  const [saved, setSaved] = useState<Segment | null>(null);
  const [videoSegments, setVideoSegments] = useState<Segment[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recStatus, setRecStatus] = useState<RecorderStatus>('idle');
  const [phase, setPhase] = useState<RepeatPhase>('idle');
  const [mic, setMic] = useState<MicPermission>('unknown');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [unsaved, setUnsaved] = useState<{ blob: Blob; mimeType: string } | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [comparingId, setComparingId] = useState<string | null>(null);
  const [libraryVersion, bumpLibrary] = useReducer((x: number) => x + 1, 0);

  const connRef = useRef<PlayerConnection | null>(null);
  const pendingRef = useRef<Segment | null>(null);
  const autoStopRef = useRef(false);

  const send = useCallback((cmd: PlayerCommand) => connRef.current?.send(cmd) ?? false, []);
  const attemptPlayer = useAttemptPlayer(() => {
    if (live.current.player && !live.current.player.paused) send({ type: 'pause' });
  });

  // ---- recorder ----
  const recorderRef = useRef<RecorderService | null>(null);
  if (!recorderRef.current) {
    recorderRef.current = new RecorderService(
      {
        store,
        getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
        createRecorder: (stream, options) => new MediaRecorder(stream, options),
        isTypeSupported: (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
        fixDuration,
      },
      {
        onStatus: setRecStatus,
        onSaved: (rec) => live.current.onSaved(rec),
        onError: (err) => setNotice({ tone: 'error', text: err.message }),
        onUnsaved: (blob, mimeType, err) => {
          setUnsaved({ blob, mimeType });
          setNotice({ tone: 'error', text: `${err.message} Download it now so it is not lost.` });
        },
      },
    );
  }
  const recorder = recorderRef.current;
  useRecordingIndicator(recStatus === 'recording');
  useTicker(recStatus === 'recording', 100);

  // ---- derived segment state ----
  const start = ws.startText ? parseTimestamp(ws.startText) : null;
  const end = ws.endText ? parseTimestamp(ws.endText) : null;
  const segmentError = ws.startText || ws.endText ? validateSegment(start, end, player?.duration) : null;
  const bounds = useMemo(() => (!segmentError && start !== null && end !== null ? { start, end } : null), [segmentError, start, end]);
  const saveState: SaveState = !saved ? 'new' : bounds && sameBounds(saved, bounds) ? 'saved' : recordings.length > 0 ? 'modified-new' : 'modified';
  const onCurrentVideo = !!player && connection.kind === 'connected' && player.status.kind === 'ready' && player.videoId === ws.videoId;

  // Values the long-lived callbacks (port events, recorder) need at call time.
  const live = useRef({ player, settings, phase, comparingId, recordings, onSaved: (_r: Recording) => {} });
  live.current.player = player;
  live.current.settings = settings;
  live.current.phase = phase;
  live.current.comparingId = comparingId;
  live.current.recordings = recordings;

  const refreshVideoSegments = useCallback(async (videoId: string | null) => {
    setVideoSegments(videoId ? await store.listSegmentsForVideo(videoId) : []);
  }, []);

  const refreshRecordings = useCallback(async (segmentId: string | null) => {
    setRecordings(segmentId ? await store.listRecordings(segmentId) : []);
  }, []);

  live.current.onSaved = (rec) => {
    setHighlightId(rec.id);
    setNotice({ tone: 'success', text: `Attempt ${rec.attempt} saved.` });
    void refreshRecordings(rec.segmentId);
    bumpLibrary();
    if (live.current.settings.mode === 'repeat') setPhase('done');
  };

  // ---- startup: settings, mic permission, crash recovery, player connection ----
  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setLanguage(s.language);
    });
    void navigator.storage?.persist?.().catch(() => undefined);
    (recovery ??= store.recoverDrafts(fixDuration, recorder.activeDraftIds()))
      .then((recovered) => {
        if (recovered.length) {
          setNotice({ tone: 'info', text: `Recovered ${recovered.length} recording${recovered.length === 1 ? '' : 's'} that were interrupted when the panel closed.` });
          bumpLibrary();
        }
      })
      .catch((err: unknown) => setNotice({ tone: 'error', text: errorText(err) }));
    return watchMicPermission(setMic);
  }, [recorder]);

  useEffect(() => {
    const conn = new PlayerConnection({
      fixedTabId,
      onConnection: (c) => {
        setConnection(c);
        if (c.kind !== 'connected') setPlayer(null);
      },
      onEvent: (e: PlayerEvent) => handleEvent.current(e),
    });
    connRef.current = conn;
    conn.start().catch((err: unknown) => setNotice({ tone: 'error', text: errorText(err) }));
    return () => conn.dispose();
  }, []);

  const handleEvent = useRef<(e: PlayerEvent) => void>(() => {});
  handleEvent.current = (e) => {
    if (e.type === 'state') {
      setPlayer(e.state);
      // Pause attempt playback when the video starts, so the two never overlap.
      if (!e.state.paused && live.current.player?.paused !== false) attemptPlayer.pause();
    } else if (e.type === 'error') {
      setNotice({ tone: 'error', text: e.message });
    } else if (e.type === 'segmentEnd') {
      if (autoStopRef.current && recorder.status === 'recording') {
        autoStopRef.current = false;
        send({ type: 'pause' });
        void recorder.stop();
      }
      if (e.mode === 'once') {
        const compareId = live.current.comparingId;
        if (compareId) {
          setComparingId(null);
          const rec = live.current.recordings.find((r) => r.id === compareId);
          if (rec) attemptPlayer.play(rec);
        } else if (live.current.phase === 'listening') {
          setPhase('your-turn');
        }
      }
    }
  };

  // ---- follow the video in the tab ----
  const playerVideoId = player?.videoId ?? null;
  const playerReady = player?.status.kind === 'ready';
  useEffect(() => {
    if (!playerVideoId || playerVideoId === ws.videoId) return;
    const pending = pendingRef.current;
    attemptPlayer.stop();
    setPhase('idle');
    setComparingId(null);
    if (pending && pending.videoId === playerVideoId) {
      loadSegment(pending);
    } else {
      // A segment already in the content script (e.g. panel reopened while looping) is adopted.
      const s = live.current.player?.segment;
      setWs({ videoId: playerVideoId, segmentId: null, startText: s ? formatTimestamp(s.start, 'floor') : '', endText: s ? formatTimestamp(s.end, 'ceil') : '' });
      setSaved(null);
      setRecordings([]);
      void store.listSegmentsForVideo(playerVideoId).then((segs) => {
        setVideoSegments(segs);
        const match = s && segs.find((x) => sameBounds(x, s));
        if (match) loadSegment(match);
      });
    }
    void refreshVideoSegments(playerVideoId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerVideoId]);

  // Apply a segment opened from the Library once its video is ready: seek to its start.
  useEffect(() => {
    const pending = pendingRef.current;
    if (pending && playerReady && playerVideoId === pending.videoId) {
      pendingRef.current = null;
      send({ type: 'setSegment', segment: { start: pending.start, end: pending.end } });
      send({ type: 'seek', time: pending.start });
    }
  }, [playerReady, playerVideoId, send]);

  // Keep the content script's segment in sync with valid bounds.
  const boundsKey = bounds ? `${bounds.start}-${bounds.end}` : 'none';
  useEffect(() => {
    if (!onCurrentVideo) return;
    const current = live.current.player?.segment ?? null;
    if (bounds && current && sameBounds(bounds, current)) return;
    if (!bounds && !current) return;
    send({ type: 'setSegment', segment: bounds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, onCurrentVideo, send]);

  function loadSegment(seg: Segment) {
    setWs({ videoId: seg.videoId, segmentId: seg.id, startText: formatTimestamp(seg.start, 'floor'), endText: formatTimestamp(seg.end, 'ceil') });
    setSaved(seg);
    setLanguage(seg.language);
    setHighlightId(null);
    void refreshRecordings(seg.id);
  }

  // ---- actions ----

  const updateSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    void saveSettings(next).catch(() => undefined);
  };

  /** Returns the saved segment for the current bounds, creating or updating it as needed. */
  async function ensureSegment(): Promise<Segment> {
    if (!bounds || !player?.videoId) throw new Error('Select a valid segment first.');
    const lang = language.trim() || 'English';
    if (saved && saved.videoId === player.videoId) {
      if (sameBounds(saved, bounds) && saved.language === lang) return saved;
      if (sameBounds(saved, bounds) || recordings.length === 0) {
        const updated = await store.updateSegment(saved.id, { ...bounds, language: lang, videoTitle: player.title || saved.videoTitle });
        setSaved(updated);
        void refreshVideoSegments(updated.videoId);
        bumpLibrary();
        return updated;
      }
    }
    const seg = await store.createSegment({ videoId: player.videoId, videoUrl: watchUrl(player.videoId), videoTitle: player.title, language: lang, ...bounds });
    setWs((w) => ({ ...w, segmentId: seg.id }));
    setSaved(seg);
    setRecordings([]);
    void refreshVideoSegments(seg.videoId);
    bumpLibrary();
    return seg;
  }

  async function save() {
    try {
      const seg = await ensureSegment();
      setNotice({ tone: 'success', text: `Segment #${seg.number} saved to the library.` });
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err) });
    }
  }

  async function startAttempt() {
    if (recorder.status !== 'idle') return;
    setNotice(null);
    let seg: Segment;
    try {
      seg = await ensureSegment();
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err) });
      return;
    }
    attemptPlayer.stop();
    setComparingId(null);
    const shadowing = settings.mode === 'shadowing';
    if (!shadowing) send({ type: 'pause' });
    try {
      await recorder.start(seg.id);
    } catch (err) {
      handleRecordError(err);
      return;
    }
    if (shadowing) {
      autoStopRef.current = settings.autoStop;
      send({ type: 'playSegment', mode: 'loop' });
    }
  }

  function handleRecordError(err: unknown) {
    if (err instanceof RecorderError && err.code === 'permission-denied') {
      if (mic === 'denied') {
        setNotice({ tone: 'error', text: 'Microphone access is blocked for Shadowing Studio.', action: { label: 'Open settings', run: () => void openMicSettings() } });
      } else {
        // The side panel could not show Chrome's prompt; grant it once in a normal tab.
        setNotice({ tone: 'info', text: 'Chrome needs your permission to use the microphone. Allow it in the tab that opens, then come back.', action: { label: 'Open', run: () => void openPermissionPage() } });
        void openPermissionPage();
      }
      return;
    }
    setNotice({ tone: 'error', text: errorText(err) });
  }

  async function micSetup() {
    if (mic === 'denied') {
      void openMicSettings();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      void openPermissionPage();
    }
  }

  async function stopAttempt() {
    autoStopRef.current = false;
    await recorder.stop();
  }

  function listen() {
    if (!bounds) return;
    attemptPlayer.stop();
    setComparingId(null);
    setPhase('listening');
    send({ type: 'playSegment', mode: 'once' });
  }

  function togglePlay() {
    if (!player) return;
    send({ type: player.paused ? 'play' : 'pause' });
  }

  function toggleLoop() {
    if (!bounds || !player) return;
    if (player.loopMode === 'loop') send({ type: 'setLoopMode', mode: 'off' });
    else send({ type: 'playSegment', mode: 'loop' });
  }

  function reset() {
    setWs((w) => ({ ...w, segmentId: null, startText: '', endText: '' }));
    setSaved(null);
    setRecordings([]);
    setPhase('idle');
    send({ type: 'setSegment', segment: null });
  }

  function setStartText(text: string) {
    setWs((w) => ({ ...w, startText: text }));
    setPhase('idle');
  }

  function setEndText(text: string) {
    setWs((w) => ({ ...w, endText: text }));
    setPhase('idle');
  }

  function compare(rec: Recording) {
    if (!bounds) return;
    attemptPlayer.stop();
    setComparingId(rec.id);
    send({ type: 'playSegment', mode: 'once' });
  }

  async function deleteRecording(rec: Recording) {
    try {
      if (attemptPlayer.currentId === rec.id) attemptPlayer.stop();
      await store.deleteRecording(rec.id);
      await refreshRecordings(rec.segmentId);
      bumpLibrary();
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err) });
    }
  }

  async function updateRecording(rec: Recording, patch: { name?: string; notes?: string }) {
    try {
      await store.updateRecording(rec.id, patch);
      await refreshRecordings(rec.segmentId);
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err) });
    }
  }

  async function exportItems(items: ExportItem[]) {
    if (items.length === 0) {
      setNotice({ tone: 'info', text: 'There are no recordings to export yet.' });
      return;
    }
    try {
      const result = await downloadFiles(planExport(items, items.length > 1));
      if (result.failed.length) {
        setNotice({ tone: 'error', text: `${result.failed.length} file(s) could not be exported: ${result.failed[0].error}` });
      } else {
        setNotice({ tone: 'success', text: `Exported ${items.length} recording${items.length === 1 ? '' : 's'} to Downloads/Shadowing Studio.` });
      }
    } catch (err) {
      setNotice({ tone: 'error', text: `Export failed: ${errorText(err)}` });
    }
  }

  async function exportSegments(segments: Segment[]) {
    try {
      const items: ExportItem[] = [];
      for (const segment of segments) for (const recording of await store.listRecordings(segment.id)) items.push({ segment, recording });
      await exportItems(items);
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err) });
    }
  }

  async function deleteSegment(seg: Segment) {
    try {
      await store.deleteSegment(seg.id);
      if (saved?.id === seg.id) {
        setSaved(null);
        setRecordings([]);
        setWs((w) => ({ ...w, segmentId: null }));
      }
      void refreshVideoSegments(ws.videoId);
      bumpLibrary();
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err) });
    }
  }

  async function resume(seg: Segment) {
    setTab('practice');
    setNotice(null);
    if (player?.videoId === seg.videoId && connection.kind === 'connected') {
      loadSegment(seg);
      send({ type: 'setSegment', segment: { start: seg.start, end: seg.end } });
      send({ type: 'seek', time: seg.start });
      return;
    }
    pendingRef.current = seg;
    try {
      await connRef.current?.open(watchUrl(seg.videoId, seg.start));
    } catch (err) {
      pendingRef.current = null;
      setNotice({ tone: 'error', text: `Could not open the video: ${errorText(err)}` });
    }
  }

  const recordingCount = recordings.length;
  const segmentLength = bounds ? bounds.end - bounds.start : null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <img src="../icons/icon32.png" alt="" />
          <span>Shadowing Studio</span>
          <span className="spacer" />
          {recStatus === 'recording' ? (
            <span className="chip danger">
              <span className="rec-dot" aria-hidden /> REC
            </span>
          ) : connection.kind === 'connected' && player?.status.kind === 'ready' ? (
            <span className="chip ok">
              <span className="dot" /> Connected
            </span>
          ) : null}
        </div>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {(
            [
              ['practice', 'Practice'],
              ['recordings', 'Recordings'],
              ['library', 'Library'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
              {id === 'recordings' && recordingCount > 0 && <span className="count">{recordingCount}</span>}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {unsaved && (
          <Banner
            tone="error"
            action={
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  void downloadUnsaved(unsaved.blob, unsaved.mimeType).then((r) => {
                    if (r.saved) setUnsaved(null);
                  })
                }
              >
                <Icon name="download" /> Download
              </button>
            }
          >
            A recording could not be saved to the library.
          </Banner>
        )}
        {notice && (
          <Banner
            tone={notice.tone}
            onDismiss={() => setNotice(null)}
            action={
              notice.action && (
                <button type="button" className="btn btn-sm" onClick={notice.action.run}>
                  {notice.action.label}
                </button>
              )
            }
          >
            {notice.text}
          </Banner>
        )}

        {tab === 'practice' && (
          <PracticeView
            connection={connection}
            player={player}
            onReloadTab={() => void connRef.current?.reloadTab()}
            onOpenYouTube={() => void chrome.tabs.create({ url: 'https://www.youtube.com/' })}
            language={language}
            onLanguageChange={(l) => {
              setLanguage(l);
              if (l.trim()) updateSettings({ language: l.trim() });
            }}
            startText={ws.startText}
            endText={ws.endText}
            onStartChange={setStartText}
            onEndChange={setEndText}
            onSetStartNow={() => player && setStartText(formatTimestamp(player.currentTime, 'floor'))}
            onSetEndNow={() => player && setEndText(endTimestamp(player.currentTime, player.duration))}
            segmentError={segmentError}
            segmentLength={segmentLength}
            saveState={saveState}
            savedSegment={saved}
            attemptCount={recordingCount}
            onSave={() => void save()}
            onReset={reset}
            videoSegments={videoSegments}
            onPickSegment={(s) => {
              loadSegment(s);
              send({ type: 'setSegment', segment: { start: s.start, end: s.end } });
              send({ type: 'seek', time: s.start });
            }}
            onPreview={() => send({ type: 'playSegment', mode: 'once' })}
            onPlayPause={togglePlay}
            onRestart={() => bounds && send({ type: 'seek', time: bounds.start })}
            onToggleLoop={toggleLoop}
            mode={settings.mode}
            onModeChange={(mode: PracticeMode) => {
              updateSettings({ mode });
              setPhase('idle');
            }}
            autoStop={settings.autoStop}
            onAutoStopChange={(autoStop) => updateSettings({ autoStop })}
            mic={mic}
            onMicSetup={() => void micSetup()}
            recorderStatus={recStatus}
            elapsedMs={recorder.elapsedMs()}
            onRecord={() => void startAttempt()}
            onStop={() => void stopAttempt()}
            phase={phase}
            onListen={listen}
            onShowRecordings={() => setTab('recordings')}
          />
        )}

        {tab === 'recordings' && (
          <RecordingsView
            segment={saved}
            recordings={recordings}
            player={attemptPlayer}
            highlightId={highlightId}
            comparingId={comparingId}
            canControlVideo={onCurrentVideo && !!bounds}
            busy={recStatus !== 'idle'}
            onPlayOriginal={() => {
              attemptPlayer.stop();
              send({ type: 'playSegment', mode: 'once' });
            }}
            onCompare={compare}
            onDelete={(r) => void deleteRecording(r)}
            onUpdate={(r, patch) => void updateRecording(r, patch)}
            onExport={(recs) => saved && void exportItems(recs.map((recording) => ({ segment: saved, recording })))}
            onGoToPractice={() => setTab('practice')}
          />
        )}

        {tab === 'library' && <LibraryView store={store} version={libraryVersion} currentSegmentId={saved?.id ?? null} onResume={(s) => void resume(s)} onExport={(s) => void exportSegments(s)} onDelete={(s) => void deleteSegment(s)} />}
      </main>
    </div>
  );
}
