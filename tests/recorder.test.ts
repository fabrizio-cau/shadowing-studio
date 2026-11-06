import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import { mapMediaError, pickMimeType, RecorderError, RecorderService, type RecorderDeps } from '../src/sidepanel/recorder';
import { ShadowingStore } from '../src/storage/db';

class FakeTrack extends EventTarget {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

class FakeRecorder {
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  timeslice = 0;
  constructor(readonly stream: FakeStream, readonly mimeType: string) {}
  start(timeslice: number) {
    this.timeslice = timeslice;
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.emit('|end');
    queueMicrotask(() => this.onstop?.());
  }
}

const SEG = { videoId: 'abcdefghijk', videoUrl: 'u', videoTitle: 't', language: 'German', start: 0, end: 2 };

function setup(overrides: Partial<RecorderDeps> = {}) {
  const dbName = `rec-${Math.random()}`;
  const store = new ShadowingStore(dbName);
  let clock = 0;
  const recorders: FakeRecorder[] = [];
  const streams: FakeStream[] = [];
  const callbacks = { onStatus: vi.fn(), onSaved: vi.fn(), onError: vi.fn(), onUnsaved: vi.fn() };
  const deps: RecorderDeps = {
    store,
    getUserMedia: vi.fn(async () => {
      const s = new FakeStream();
      streams.push(s);
      return s as unknown as MediaStream;
    }),
    createRecorder: (stream, options) => {
      const r = new FakeRecorder(stream as unknown as FakeStream, options.mimeType ?? 'audio/webm');
      recorders.push(r);
      return r as unknown as MediaRecorder;
    },
    isTypeSupported: (t) => t.startsWith('audio/webm'),
    now: () => clock,
    ...overrides,
  };
  const service = new RecorderService(deps, callbacks);
  return { store, dbName, service, recorders, streams, callbacks, deps, tick: (ms: number) => (clock += ms) };
}

/** Lets queued chunk writes reach IndexedDB. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('MIME type selection', () => {
  it('prefers WebM/Opus and falls back in order', () => {
    expect(pickMimeType(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickMimeType((t) => t === 'audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus');
    expect(pickMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMimeType(() => false)).toBe('');
  });
});

describe('RecorderService', () => {
  it('records the microphone only and saves an attempt', async () => {
    const { store, service, recorders, streams, callbacks, deps, tick } = setup();
    const seg = await store.createSegment(SEG);
    await service.start(seg.id);
    expect(deps.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Object), video: false }));
    expect(service.status).toBe('recording');
    expect(recorders[0].mimeType).toBe('audio/webm;codecs=opus');
    expect(recorders[0].timeslice).toBe(1000);
    recorders[0].emit('a');
    tick(1000);
    recorders[0].emit('b');
    tick(500);
    expect(service.elapsedMs()).toBe(1500);
    const rec = await service.stop();
    expect(rec).not.toBeNull();
    expect(rec).toMatchObject({ segmentId: seg.id, attempt: 1, durationMs: 1500, mimeType: 'audio/webm;codecs=opus' });
    expect(await rec!.blob.text()).toBe('ab|end');
    expect(streams[0].tracks[0].stopped).toBe(true); // microphone released
    expect(service.status).toBe('idle');
    expect(callbacks.onSaved).toHaveBeenCalledWith(rec);
    expect(callbacks.onStatus.mock.calls.map((c) => c[0])).toEqual(['starting', 'recording', 'stopping', 'idle']);
  });

  it('persists chunks while recording (crash safety)', async () => {
    const { store, dbName, service, recorders } = setup();
    const seg = await store.createSegment(SEG);
    await service.start(seg.id);
    recorders[0].emit('one');
    recorders[0].emit('two');
    await settle();
    const db = await openDB(dbName);
    expect(await db.count('chunks')).toBe(2);
    db.close();
    // The live draft is not "recovered" from under the recorder.
    expect(await store.recoverDrafts(undefined, service.activeDraftIds())).toEqual([]);
    await service.stop();
  });

  it('keeps multiple independent attempts', async () => {
    const { store, service, recorders } = setup();
    const seg = await store.createSegment(SEG);
    for (const word of ['first', 'second', 'third']) {
      await service.start(seg.id);
      recorders.at(-1)!.emit(word);
      await service.stop();
    }
    const list = await store.listRecordings(seg.id);
    expect(list.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(await Promise.all(list.map((r) => r.blob.text()))).toEqual(['first|end', 'second|end', 'third|end']);
  });

  it('refuses to start twice', async () => {
    const { store, service } = setup();
    const seg = await store.createSegment(SEG);
    await service.start(seg.id);
    await expect(service.start(seg.id)).rejects.toBeInstanceOf(RecorderError);
    await service.stop();
  });

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['NotFoundError', 'no-microphone'],
    ['NotReadableError', 'mic-busy'],
    ['TypeError', 'unknown'],
  ])('maps %s to %s and cleans up', async (name, code) => {
    const { store, dbName, service } = setup({ getUserMedia: () => Promise.reject(new DOMException('x', name)) });
    const seg = await store.createSegment(SEG);
    await expect(service.start(seg.id)).rejects.toMatchObject({ code });
    expect(service.status).toBe('idle');
    const db = await openDB(dbName);
    expect(await db.count('drafts')).toBe(0);
    db.close();
  });

  it('keeps the audio when the microphone is disconnected', async () => {
    const { store, service, recorders, streams, callbacks } = setup();
    const seg = await store.createSegment(SEG);
    await service.start(seg.id);
    recorders[0].emit('partial');
    streams[0].tracks[0].dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(callbacks.onSaved).toHaveBeenCalled());
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'interrupted' }));
    const [rec] = await store.listRecordings(seg.id);
    expect(await rec.blob.text()).toBe('partial|end');
  });

  it('keeps the audio when MediaRecorder reports an error', async () => {
    const { store, service, recorders, callbacks } = setup();
    const seg = await store.createSegment(SEG);
    await service.start(seg.id);
    recorders[0].emit('x');
    recorders[0].onerror?.(new Event('error'));
    await vi.waitFor(() => expect(callbacks.onSaved).toHaveBeenCalled());
    expect(await store.listRecordings(seg.id)).toHaveLength(1);
  });

  it('hands the audio to the UI when saving fails, instead of discarding it', async () => {
    const { store, service, recorders, callbacks } = setup();
    const seg = await store.createSegment(SEG);
    await service.start(seg.id);
    recorders[0].emit('precious');
    vi.spyOn(store, 'finalizeDraft').mockRejectedValueOnce(new Error('QuotaExceededError'));
    expect(await service.stop()).toBeNull();
    expect(callbacks.onUnsaved).toHaveBeenCalledTimes(1);
    const [blob, mime, err] = callbacks.onUnsaved.mock.calls[0];
    expect(await (blob as Blob).text()).toBe('precious|end');
    expect(mime).toBe('audio/webm;codecs=opus');
    expect(err).toMatchObject({ code: 'storage' });
    // The draft is still in IndexedDB and can be recovered later.
    expect(await store.recoverDrafts()).toHaveLength(1);
  });

  it('adds the WebM duration header', async () => {
    const fixDuration = vi.fn(async (b: Blob) => new Blob([await b.text(), '+fixed'], { type: b.type }));
    const { store, service, recorders, tick } = setup({ fixDuration });
    const seg = await store.createSegment(SEG);
    await service.start(seg.id);
    recorders[0].emit('a');
    tick(2000);
    const rec = await service.stop();
    expect(fixDuration).toHaveBeenCalledWith(expect.any(Blob), 2000);
    expect(await rec!.blob.text()).toBe('a|end+fixed');
  });

  it('discards an empty take and reports it', async () => {
    const { store, service, recorders, callbacks } = setup();
    const seg = await store.createSegment(SEG);
    await service.start(seg.id);
    recorders[0].ondataavailable = null; // nothing captured
    expect(await service.stop()).toBeNull();
    expect(callbacks.onError).toHaveBeenCalled();
    expect(await store.listRecordings(seg.id)).toEqual([]);
  });

  it('maps errors from non-DOM values', () => {
    expect(mapMediaError('weird').code).toBe('unknown');
  });
});
