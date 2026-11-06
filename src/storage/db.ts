import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import { newId } from '../shared/id';
import type { Recording, Segment } from '../shared/types';

/** A recording in progress; its audio lives in `chunks` until it is finalised. */
export interface Draft {
  id: string;
  segmentId: string;
  mimeType: string;
  startedAt: number;
  /** Time of the last chunk written; used to estimate duration when recovering. */
  updatedAt: number;
}

export interface Chunk {
  recordingId: string;
  seq: number;
  data: Blob;
}

export interface ShadowingSchema extends DBSchema {
  segments: { key: string; value: Segment; indexes: { videoId: string; language: string } };
  recordings: { key: string; value: Recording; indexes: { segmentId: string } };
  drafts: { key: string; value: Draft };
  chunks: { key: [string, number]; value: Chunk; indexes: { recordingId: string } };
}

type Db = IDBPDatabase<ShadowingSchema>;
type UpgradeTx = IDBPTransaction<ShadowingSchema, StoreNames<ShadowingSchema>[], 'versionchange'>;
export type Migration = (db: Db, tx: UpgradeTx) => void;

/**
 * Ordered schema migrations; version N runs MIGRATIONS[N-1]. Only ever append: never edit a
 * shipped migration, because existing users have already run it.
 */
export const MIGRATIONS: Migration[] = [
  // v1: initial schema.
  (db) => {
    const segments = db.createObjectStore('segments', { keyPath: 'id' });
    segments.createIndex('videoId', 'videoId');
    segments.createIndex('language', 'language');
    const recordings = db.createObjectStore('recordings', { keyPath: 'id' });
    recordings.createIndex('segmentId', 'segmentId');
    db.createObjectStore('drafts', { keyPath: 'id' });
    const chunks = db.createObjectStore('chunks', { keyPath: ['recordingId', 'seq'] });
    chunks.createIndex('recordingId', 'recordingId');
  },
];

export const DB_NAME = 'shadowing-studio';

export function openShadowingDb(name = DB_NAME, migrations: Migration[] = MIGRATIONS): Promise<Db> {
  return openDB<ShadowingSchema>(name, migrations.length, {
    upgrade(db, oldVersion, newVersion, tx) {
      for (let v = oldVersion; v < (newVersion ?? migrations.length); v++) migrations[v](db, tx);
    },
    blocked() {
      console.warn('Shadowing Studio: database upgrade is waiting for another extension page to close.');
    },
    blocking() {
      // A newer version of the extension wants to upgrade: let it.
      void dbPromiseCache.get(name)?.then((db) => db.close());
      dbPromiseCache.delete(name);
    },
  });
}

const dbPromiseCache = new Map<string, Promise<Db>>();

/** Turns IndexedDB failures into messages a user can act on. */
export class StorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

function wrap(err: unknown, action: string): StorageError {
  if (err instanceof StorageError) return err;
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'QuotaExceededError') {
    return new StorageError(`Could not ${action}: the browser's storage is full. Export and delete old recordings to free space.`, err);
  }
  return new StorageError(`Could not ${action}: ${err instanceof Error ? err.message : String(err)}`, err);
}

export type NewSegment = Pick<Segment, 'videoId' | 'videoUrl' | 'videoTitle' | 'language' | 'start' | 'end'>;
export type FixDuration = (blob: Blob, durationMs: number) => Promise<Blob>;

export class ShadowingStore {
  private readonly dbp: Promise<Db>;

  constructor(name = DB_NAME, migrations: Migration[] = MIGRATIONS, private readonly now: () => number = Date.now) {
    let p = dbPromiseCache.get(name);
    if (!p) {
      p = openShadowingDb(name, migrations);
      dbPromiseCache.set(name, p);
      p.catch(() => dbPromiseCache.delete(name));
    }
    this.dbp = p;
  }

  private async run<T>(action: string, fn: (db: Db) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.dbp);
    } catch (err) {
      throw wrap(err, action);
    }
  }

  // ---- segments ----

  createSegment(input: NewSegment): Promise<Segment> {
    return this.run('save the segment', async (db) => {
      const tx = db.transaction('segments', 'readwrite');
      const existing = await tx.store.index('videoId').getAll(input.videoId);
      const now = this.now();
      const segment: Segment = {
        ...input,
        id: newId(),
        number: existing.reduce((max, s) => Math.max(max, s.number), 0) + 1,
        nextAttempt: 1,
        createdAt: now,
        updatedAt: now,
      };
      await tx.store.add(segment);
      await tx.done;
      return segment;
    });
  }

  updateSegment(id: string, patch: Partial<Pick<Segment, 'start' | 'end' | 'language' | 'videoTitle'>>): Promise<Segment> {
    return this.run('update the segment', async (db) => {
      const tx = db.transaction('segments', 'readwrite');
      const current = await tx.store.get(id);
      if (!current) throw new StorageError('This segment no longer exists.');
      const next = { ...current, ...patch, updatedAt: this.now() };
      await tx.store.put(next);
      await tx.done;
      return next;
    });
  }

  getSegment(id: string): Promise<Segment | undefined> {
    return this.run('load the segment', (db) => db.get('segments', id));
  }

  listSegments(): Promise<Segment[]> {
    return this.run('load the library', (db) => db.getAll('segments'));
  }

  listSegmentsForVideo(videoId: string): Promise<Segment[]> {
    return this.run('load segments', async (db) => (await db.getAllFromIndex('segments', 'videoId', videoId)).sort((a, b) => a.number - b.number));
  }

  /** Deletes a segment and all its recordings. */
  deleteSegment(id: string): Promise<void> {
    return this.run('delete the segment', async (db) => {
      const tx = db.transaction(['segments', 'recordings'], 'readwrite');
      const recs = tx.objectStore('recordings');
      for (const key of await recs.index('segmentId').getAllKeys(id)) await recs.delete(key);
      await tx.objectStore('segments').delete(id);
      await tx.done;
    });
  }

  // ---- recordings ----

  listRecordings(segmentId: string): Promise<Recording[]> {
    return this.run('load recordings', async (db) => (await db.getAllFromIndex('recordings', 'segmentId', segmentId)).sort((a, b) => a.attempt - b.attempt));
  }

  getRecording(id: string): Promise<Recording | undefined> {
    return this.run('load the recording', (db) => db.get('recordings', id));
  }

  updateRecording(id: string, patch: Partial<Pick<Recording, 'name' | 'notes'>>): Promise<Recording> {
    return this.run('update the recording', async (db) => {
      const tx = db.transaction('recordings', 'readwrite');
      const current = await tx.store.get(id);
      if (!current) throw new StorageError('This recording no longer exists.');
      const next = { ...current, ...patch };
      await tx.store.put(next);
      await tx.done;
      return next;
    });
  }

  deleteRecording(id: string): Promise<void> {
    return this.run('delete the recording', (db) => db.delete('recordings', id));
  }

  /** Number of attempts per segment id. Reads keys only, not audio. */
  countRecordingsBySegment(): Promise<Map<string, number>> {
    return this.run('count recordings', async (db) => {
      const counts = new Map<string, number>();
      let cursor = await db.transaction('recordings').store.index('segmentId').openKeyCursor();
      while (cursor) {
        const key = cursor.key as string;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        cursor = await cursor.continue();
      }
      return counts;
    });
  }

  usage(): Promise<{ recordings: number; bytes: number }> {
    return this.run('measure storage', async (db) => {
      let recordings = 0;
      let bytes = 0;
      let cursor = await db.transaction('recordings').store.openCursor();
      while (cursor) {
        recordings++;
        bytes += cursor.value.blob.size;
        cursor = await cursor.continue();
      }
      return { recordings, bytes };
    });
  }

  // ---- recording lifecycle (crash-safe) ----

  beginDraft(segmentId: string, mimeType: string): Promise<Draft> {
    return this.run('start the recording', async (db) => {
      const now = this.now();
      const draft: Draft = { id: newId(), segmentId, mimeType, startedAt: now, updatedAt: now };
      await db.add('drafts', draft);
      return draft;
    });
  }

  appendChunk(draftId: string, seq: number, data: Blob): Promise<void> {
    return this.run('save recorded audio', async (db) => {
      const tx = db.transaction(['chunks', 'drafts'], 'readwrite');
      await tx.objectStore('chunks').put({ recordingId: draftId, seq, data });
      const draft = await tx.objectStore('drafts').get(draftId);
      if (draft) await tx.objectStore('drafts').put({ ...draft, updatedAt: this.now() });
      await tx.done;
    });
  }

  /**
   * Turns a draft into a recording, assigning the next attempt number, and removes its chunks,
   * all in one transaction. `blob` is the assembled audio.
   */
  finalizeDraft(draftId: string, blob: Blob, durationMs: number, recovered = false): Promise<Recording> {
    return this.run('save the recording', async (db) => {
      const tx = db.transaction(['segments', 'recordings', 'drafts', 'chunks'], 'readwrite');
      const draft = await tx.objectStore('drafts').get(draftId);
      if (!draft) throw new StorageError('The recording draft is missing.');
      const segments = tx.objectStore('segments');
      const segment = await segments.get(draft.segmentId);
      if (!segment) throw new StorageError('The segment for this recording was deleted.');
      const attempt = segment.nextAttempt;
      await segments.put({ ...segment, nextAttempt: attempt + 1, updatedAt: this.now() });
      const recording: Recording = {
        id: draft.id,
        segmentId: draft.segmentId,
        attempt,
        createdAt: draft.startedAt,
        durationMs: Math.max(0, Math.round(durationMs)),
        mimeType: draft.mimeType || blob.type,
        blob,
        name: '',
        notes: recovered ? 'Recovered after the panel closed during recording.' : '',
        ...(recovered ? { recovered: true } : {}),
      };
      await tx.objectStore('recordings').add(recording);
      await tx.objectStore('drafts').delete(draftId);
      const chunks = tx.objectStore('chunks');
      for (const key of await chunks.index('recordingId').getAllKeys(draftId)) await chunks.delete(key);
      await tx.done;
      return recording;
    });
  }

  discardDraft(draftId: string): Promise<void> {
    return this.run('discard the recording draft', async (db) => {
      const tx = db.transaction(['drafts', 'chunks'], 'readwrite');
      const chunks = tx.objectStore('chunks');
      for (const key of await chunks.index('recordingId').getAllKeys(draftId)) await chunks.delete(key);
      await tx.objectStore('drafts').delete(draftId);
      await tx.done;
    });
  }

  /**
   * Rebuilds recordings whose panel closed before they were finalised. Drafts without audio, or
   * whose segment was deleted meanwhile, are removed. `skip` excludes drafts still in progress.
   */
  async recoverDrafts(fixDuration?: FixDuration, skip: ReadonlySet<string> = new Set()): Promise<Recording[]> {
    const drafts = await this.run('check for interrupted recordings', (db) => db.getAll('drafts'));
    const recovered: Recording[] = [];
    for (const draft of drafts) {
      if (skip.has(draft.id)) continue;
      const parts = await this.run('read interrupted recording', (db) => db.getAllFromIndex('chunks', 'recordingId', draft.id));
      const segment = await this.getSegment(draft.segmentId);
      if (parts.length === 0 || !segment) {
        await this.discardDraft(draft.id);
        continue;
      }
      parts.sort((a, b) => a.seq - b.seq);
      const durationMs = Math.max(draft.updatedAt - draft.startedAt, 0);
      let blob = new Blob(parts.map((p) => p.data), { type: draft.mimeType });
      if (fixDuration) {
        try {
          blob = await fixDuration(blob, durationMs);
        } catch {
          // Keep the unfixed audio; it plays, it just lacks a duration header.
        }
      }
      recovered.push(await this.finalizeDraft(draft.id, blob, durationMs, true));
    }
    return recovered;
  }
}
