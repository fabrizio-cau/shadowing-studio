import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openShadowingDb, ShadowingStore, StorageError, type Migration, type NewSegment } from '../src/storage/db';

let n = 0;
const freshStore = () => new ShadowingStore(`test-db-${++n}-${Math.random()}`);

const SEG: NewSegment = { videoId: 'abcdefghijk', videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk', videoTitle: 'A video', language: 'Spanish', start: 1, end: 3 };

async function record(store: ShadowingStore, segmentId: string, parts: string[], durationMs = 1500) {
  const draft = await store.beginDraft(segmentId, 'audio/webm');
  for (const [i, p] of parts.entries()) await store.appendChunk(draft.id, i, new Blob([p]));
  return store.finalizeDraft(draft.id, new Blob(parts, { type: 'audio/webm' }), durationMs);
}

describe('ShadowingStore: segments', () => {
  it('creates segments numbered per video', async () => {
    const store = freshStore();
    const a = await store.createSegment(SEG);
    const b = await store.createSegment({ ...SEG, start: 5, end: 6 });
    const other = await store.createSegment({ ...SEG, videoId: 'zzzzzzzzzzz' });
    expect([a.number, b.number, other.number]).toEqual([1, 2, 1]);
    expect(a.nextAttempt).toBe(1);
    expect((await store.listSegmentsForVideo(SEG.videoId)).map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('updates segment metadata', async () => {
    const store = freshStore();
    const a = await store.createSegment(SEG);
    const u = await store.updateSegment(a.id, { start: 2, language: 'French' });
    expect(u).toMatchObject({ start: 2, end: 3, language: 'French' });
    expect(await store.getSegment(a.id)).toMatchObject({ start: 2, language: 'French' });
    await expect(store.updateSegment('missing', { start: 1 })).rejects.toBeInstanceOf(StorageError);
  });

  it('deletes a segment with its recordings', async () => {
    const store = freshStore();
    const a = await store.createSegment(SEG);
    const keep = await store.createSegment({ ...SEG, start: 9, end: 10 });
    await record(store, a.id, ['x']);
    const kept = await record(store, keep.id, ['y']);
    await store.deleteSegment(a.id);
    expect(await store.getSegment(a.id)).toBeUndefined();
    expect(await store.listRecordings(a.id)).toEqual([]);
    expect((await store.listRecordings(keep.id)).map((r) => r.id)).toEqual([kept.id]);
  });
});

describe('ShadowingStore: recordings', () => {
  it('saves and retrieves audio blobs with metadata', async () => {
    const store = freshStore();
    const seg = await store.createSegment(SEG);
    const rec = await record(store, seg.id, ['hello ', 'world'], 2345);
    const loaded = await store.getRecording(rec.id);
    expect(loaded).toMatchObject({ segmentId: seg.id, attempt: 1, durationMs: 2345, mimeType: 'audio/webm', name: '', notes: '' });
    expect(typeof loaded!.createdAt).toBe('number');
    expect(await loaded!.blob.text()).toBe('hello world');
  });

  it('numbers attempts and never reuses a number after deletion', async () => {
    const store = freshStore();
    const seg = await store.createSegment(SEG);
    const r1 = await record(store, seg.id, ['1']);
    const r2 = await record(store, seg.id, ['2']);
    await store.deleteRecording(r2.id);
    const r3 = await record(store, seg.id, ['3']);
    expect([r1.attempt, r2.attempt, r3.attempt]).toEqual([1, 2, 3]);
    const list = await store.listRecordings(seg.id);
    expect(list.map((r) => r.attempt)).toEqual([1, 3]);
    // Earlier attempts are untouched by new ones.
    expect(await list[0].blob.text()).toBe('1');
  });

  it('renames and annotates attempts', async () => {
    const store = freshStore();
    const seg = await store.createSegment(SEG);
    const r = await record(store, seg.id, ['a']);
    await store.updateRecording(r.id, { name: 'Better intonation', notes: 'Watch the "r"' });
    expect(await store.getRecording(r.id)).toMatchObject({ name: 'Better intonation', notes: 'Watch the "r"' });
  });

  it('counts recordings and measures usage', async () => {
    const store = freshStore();
    const a = await store.createSegment(SEG);
    const b = await store.createSegment({ ...SEG, start: 7, end: 8 });
    await record(store, a.id, ['aaaa']);
    await record(store, a.id, ['bb']);
    await record(store, b.id, ['c']);
    const counts = await store.countRecordingsBySegment();
    expect(counts.get(a.id)).toBe(2);
    expect(counts.get(b.id)).toBe(1);
    expect(await store.usage()).toEqual({ recordings: 3, bytes: 7 });
  });

  it('removes draft chunks when a recording is finalised', async () => {
    const name = `test-db-chunks-${Math.random()}`;
    const store = new ShadowingStore(name);
    const seg = await store.createSegment(SEG);
    await record(store, seg.id, ['a', 'b', 'c']);
    const db = await openDB(name);
    expect(await db.count('chunks')).toBe(0);
    expect(await db.count('drafts')).toBe(0);
    db.close();
  });

  it('refuses to finalise a recording whose segment was deleted', async () => {
    const store = freshStore();
    const seg = await store.createSegment(SEG);
    const draft = await store.beginDraft(seg.id, 'audio/webm');
    await store.deleteSegment(seg.id);
    await expect(store.finalizeDraft(draft.id, new Blob(['x']), 10)).rejects.toThrow(/deleted/);
  });
});

describe('ShadowingStore: crash recovery', () => {
  it('rebuilds interrupted recordings from their chunks, in order', async () => {
    let now = 1_000;
    const name = `test-db-recover-${Math.random()}`;
    const store = new ShadowingStore(name, MIGRATIONS, () => now);
    const seg = await store.createSegment(SEG);
    const draft = await store.beginDraft(seg.id, 'audio/webm');
    now = 2_000;
    await store.appendChunk(draft.id, 1, new Blob(['B']));
    now = 3_500;
    await store.appendChunk(draft.id, 0, new Blob(['A']));
    // "Panel closes": a new store instance on the same database recovers it.
    const fixed: number[] = [];
    const recovered = await new ShadowingStore(name).recoverDrafts(async (blob, ms) => {
      fixed.push(ms);
      return blob;
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ attempt: 1, recovered: true, durationMs: 2_500 });
    expect(fixed).toEqual([2_500]);
    expect(await recovered[0].blob.text()).toBe('AB');
    expect(await store.listRecordings(seg.id)).toHaveLength(1);
  });

  it('drops empty drafts and skips drafts that are still recording', async () => {
    const store = freshStore();
    const seg = await store.createSegment(SEG);
    await store.beginDraft(seg.id, 'audio/webm'); // no chunks
    const live = await store.beginDraft(seg.id, 'audio/webm');
    await store.appendChunk(live.id, 0, new Blob(['x']));
    expect(await store.recoverDrafts(undefined, new Set([live.id]))).toEqual([]);
    // The live draft is still there and can be finalised normally.
    const rec = await store.finalizeDraft(live.id, new Blob(['x']), 100);
    expect(rec.attempt).toBe(1);
  });
});

describe('database versioning', () => {
  it('creates the current schema from scratch', async () => {
    const name = `test-db-schema-${Math.random()}`;
    const store = new ShadowingStore(name);
    await store.listSegments();
    const db = await openDB(name);
    expect(db.version).toBe(MIGRATIONS.length);
    expect([...db.objectStoreNames].sort()).toEqual(['chunks', 'drafts', 'recordings', 'segments']);
    expect([...db.transaction('segments').store.indexNames].sort()).toEqual(['language', 'videoId']);
    db.close();
  });

  it('upgrades an existing database, keeping its data, while an older connection is open', async () => {
    const name = `test-db-upgrade-${Math.random()}`;
    // Data written by the currently shipped schema, through a store that keeps its connection open.
    const v1 = new ShadowingStore(name);
    const seg = await v1.createSegment(SEG);
    const rec = await record(v1, seg.id, ['kept']);
    // A future release appends a migration. The old connection must step aside (`blocking`).
    // The typed schema only knows today's indexes; a real future migration would extend it.
    const addIndex: Migration = (_db, tx) => void tx.objectStore('recordings').createIndex('createdAt' as 'segmentId', 'createdAt');
    const upgraded = await openShadowingDb(name, [...MIGRATIONS, addIndex]);
    expect(upgraded.version).toBe(MIGRATIONS.length + 1);
    expect([...upgraded.transaction('recordings').store.indexNames]).toContain('createdAt' as string);
    const kept = await upgraded.get('recordings', rec.id);
    expect(await kept!.blob.text()).toBe('kept');
    expect(await upgraded.get('segments', seg.id)).toMatchObject({ videoId: SEG.videoId });
    upgraded.close();
  });
});
