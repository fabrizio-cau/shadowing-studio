import type { Recording } from '../shared/types';
import type { FixDuration, ShadowingStore } from '../storage/db';

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping';

export type RecorderErrorCode = 'permission-denied' | 'no-microphone' | 'mic-busy' | 'unsupported' | 'storage' | 'interrupted' | 'unknown';

export class RecorderError extends Error {
  constructor(readonly code: RecorderErrorCode, message: string) {
    super(message);
    this.name = 'RecorderError';
  }
}

/** Preference order. WebM/Opus is what Chrome records natively. */
export const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

export function pickMimeType(isTypeSupported: (type: string) => boolean): string {
  return MIME_CANDIDATES.find((t) => isTypeSupported(t)) ?? '';
}

/** Maps getUserMedia failures to codes and messages a user can act on. */
export function mapMediaError(err: unknown): RecorderError {
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new RecorderError('permission-denied', 'Microphone access was not granted.');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new RecorderError('no-microphone', 'No microphone was found. Connect one and try again.');
    case 'NotReadableError':
    case 'AbortError':
      return new RecorderError('mic-busy', 'The microphone could not be started. Another app may be using it.');
    default:
      return new RecorderError('unknown', `Could not access the microphone: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface RecorderDeps {
  store: Pick<ShadowingStore, 'beginDraft' | 'appendChunk' | 'finalizeDraft' | 'discardDraft'>;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
  isTypeSupported: (type: string) => boolean;
  fixDuration?: FixDuration;
  now?: () => number;
  /** Chunk length. Each chunk is persisted, so at most this much audio is lost on a crash. */
  timesliceMs?: number;
}

export interface RecorderCallbacks {
  onStatus?: (status: RecorderStatus) => void;
  onSaved?: (recording: Recording) => void;
  /** A problem that ended (or prevented) a recording. */
  onError?: (error: RecorderError) => void;
  /** Saving failed: the audio is handed over so the UI can offer a direct download. */
  onUnsaved?: (blob: Blob, mimeType: string, error: RecorderError) => void;
}

interface Session {
  draftId: string;
  stream: MediaStream;
  recorder: MediaRecorder;
  mimeType: string;
  chunks: Blob[];
  writes: Promise<void>;
  startedAt: number;
  stopped: Promise<Recording | null>;
  /** Set when the recording ended for a reason other than the user pressing stop. */
  interruption: RecorderError | null;
}

/**
 * Microphone recording lifecycle. Captures only the microphone (getUserMedia audio), never tab
 * or page audio. The stream is opened per attempt and closed when it stops, so the browser's
 * microphone indicator is only on while recording.
 */
export class RecorderService {
  private session: Session | null = null;
  private statusValue: RecorderStatus = 'idle';
  private readonly now: () => number;

  constructor(private readonly deps: RecorderDeps, private readonly callbacks: RecorderCallbacks = {}) {
    this.now = deps.now ?? (() => performance.now());
  }

  get status(): RecorderStatus {
    return this.statusValue;
  }

  /** Milliseconds recorded so far in the current attempt. */
  elapsedMs(): number {
    return this.session && this.statusValue === 'recording' ? this.now() - this.session.startedAt : 0;
  }

  /** IDs of drafts owned by this live session (so crash recovery leaves them alone). */
  activeDraftIds(): Set<string> {
    return new Set(this.session ? [this.session.draftId] : []);
  }

  /** Starts a new attempt for a saved segment. Resolves once audio is being captured. */
  async start(segmentId: string): Promise<void> {
    if (this.statusValue !== 'idle') throw new RecorderError('unknown', 'A recording is already in progress.');
    this.setStatus('starting');
    let stream: MediaStream | null = null;
    let draftId: string | null = null;
    try {
      let mimeType = pickMimeType(this.deps.isTypeSupported);
      try {
        stream = await this.deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      } catch (err) {
        throw mapMediaError(err);
      }
      let recorder: MediaRecorder;
      try {
        recorder = this.deps.createRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 96_000 } : { audioBitsPerSecond: 96_000 });
      } catch (err) {
        throw new RecorderError('unsupported', `This browser cannot record audio: ${String(err)}`);
      }
      mimeType = recorder.mimeType || mimeType || 'audio/webm';
      const draft = await this.deps.store.beginDraft(segmentId, mimeType).catch((err: unknown) => {
        throw new RecorderError('storage', err instanceof Error ? err.message : String(err));
      });
      draftId = draft.id;
      await this.begin(draft.id, stream, recorder, mimeType);
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop());
      if (draftId) void this.deps.store.discardDraft(draftId).catch(() => undefined);
      this.session = null;
      this.setStatus('idle');
      throw err instanceof RecorderError ? err : new RecorderError('unknown', String(err));
    }
  }

  private begin(draftId: string, stream: MediaStream, recorder: MediaRecorder, mimeType: string): Promise<void> {
    let resolveStopped!: (r: Recording | null) => void;
    const session: Session = {
      draftId,
      stream,
      recorder,
      mimeType,
      chunks: [],
      writes: Promise.resolve(),
      startedAt: this.now(),
      stopped: new Promise((r) => (resolveStopped = r)),
      interruption: null,
    };
    this.session = session;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (!e.data || e.data.size === 0) return;
      const seq = session.chunks.length;
      session.chunks.push(e.data);
      // Sequential writes keep chunk order. A failed write is not fatal: the chunk is still in memory.
      session.writes = session.writes
        .then(() => this.deps.store.appendChunk(draftId, seq, e.data))
        .catch((err: unknown) => console.warn('Shadowing Studio: chunk not persisted', err));
    };
    recorder.onstop = () => {
      void this.finish(session).then(resolveStopped);
    };
    recorder.onerror = (e: Event) => {
      const detail = (e as Event & { error?: DOMException }).error;
      session.interruption = new RecorderError('interrupted', `Recording stopped because of an error${detail ? `: ${detail.message}` : ''}. The audio captured so far was kept.`);
      this.stopRecorder(session);
    };
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        session.interruption = new RecorderError('interrupted', 'The microphone was disconnected. The audio captured so far was kept.');
        this.stopRecorder(session);
      });
    }

    return new Promise<void>((resolve, reject) => {
      recorder.onstart = () => {
        session.startedAt = this.now();
        this.setStatus('recording');
        resolve();
      };
      try {
        recorder.start(this.deps.timesliceMs ?? 1000);
      } catch (err) {
        reject(new RecorderError('unsupported', `Could not start recording: ${String(err)}`));
      }
    });
  }

  /** Stops the current attempt and resolves with the saved recording (null if nothing was captured). */
  async stop(): Promise<Recording | null> {
    const session = this.session;
    if (!session) return null;
    this.stopRecorder(session);
    return session.stopped;
  }

  private stopRecorder(session: Session): void {
    if (session.recorder.state === 'inactive') return;
    this.setStatus('stopping');
    try {
      session.recorder.stop();
    } catch {
      void this.finish(session);
    }
  }

  private async finish(session: Session): Promise<Recording | null> {
    if (this.session !== session) return null;
    const durationMs = this.now() - session.startedAt;
    session.stream.getTracks().forEach((t) => t.stop());
    await session.writes;
    this.session = null;
    try {
      if (session.chunks.length === 0) {
        await this.deps.store.discardDraft(session.draftId);
        this.callbacks.onError?.(session.interruption ?? new RecorderError('interrupted', 'No audio was captured.'));
        return null;
      }
      let blob = new Blob(session.chunks, { type: session.mimeType });
      if (this.deps.fixDuration && session.mimeType.includes('webm')) {
        try {
          blob = await this.deps.fixDuration(blob, durationMs);
        } catch {
          // Unfixed audio still plays; only the duration header is missing.
        }
      }
      try {
        const recording = await this.deps.store.finalizeDraft(session.draftId, blob, durationMs);
        if (session.interruption) this.callbacks.onError?.(session.interruption);
        this.callbacks.onSaved?.(recording);
        return recording;
      } catch (err) {
        // The chunks are still in IndexedDB as a draft (recovered on next start) and the
        // audio is handed to the UI for a direct download: nothing is silently discarded.
        const error = new RecorderError('storage', `The recording could not be saved: ${err instanceof Error ? err.message : String(err)}`);
        this.callbacks.onUnsaved?.(blob, session.mimeType, error);
        return null;
      }
    } finally {
      this.setStatus('idle');
    }
  }

  private setStatus(status: RecorderStatus): void {
    if (status === this.statusValue) return;
    this.statusValue = status;
    this.callbacks.onStatus?.(status);
  }
}
