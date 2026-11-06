# Shadowing Studio

A Chrome extension for **shadowing practice** on YouTube. Pick a sentence, loop it, record yourself
speaking along (or after it), compare your attempts with the original, and keep everything in a local
practice library. No account, no cloud: recordings stay on your computer.

## Features

- **Segments**: set start/end from the current position (⌖) or type `HH:MM:SS`
  (short forms such as `1:23` work too). Times are whole seconds: the start rounds down and the end
  rounds up, so a sentence is never clipped. Inputs are validated against the video length, and the
  segment's length is shown.
- **Looping**: replays the segment indefinitely, at any playback speed, without fighting YouTube's
  own controls. Looping keeps running if you close the panel.
- **Two practice modes**
  - *Shadowing*: speak along while the segment loops. *Record attempt* restarts the segment and
    records your microphone (by default it stops at the end of the segment).
  - *Listen & repeat*: *Listen* plays the segment once and pauses; then *Record* your imitation;
    *Listen again* for the next try.
- **Attempts**: unlimited independent recordings per segment, each with attempt number, date, time and
  duration. You can rename them, add notes, delete them, play them, or **Compare** (the original
  segment, then the attempt).
- **Library**: organised by Language → Video → Segment, with language and video filters. *Practice*
  reopens the video at the segment and restores it.
- **Export** to `Downloads/Shadowing Studio/<Language>/<Video>/`, e.g.
  `2026-11-06_14-03-09_My-Video_Segment01_Attempt02.webm`. You can export one attempt, a whole segment
  or a whole video (batch exports add an `info.json` with the timestamps and notes).
- **Reliability**: if the panel closes mid-recording, the audio captured up to the last second is
  recovered the next time you open it. If saving fails, the panel offers a direct download, so no
  take is silently lost.

## Install (unpacked)

Requires Node.js ≥ 20 and Chrome ≥ 116.

```bash
npm install
```

```bash
npm run build
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose the `dist/` folder.
3. Open a YouTube video and click the extension's toolbar icon: the side panel opens.
4. The first time you record, allow microphone access. If Chrome cannot show the prompt inside the side
   panel, a small tab opens where you allow it once.

YouTube tabs that were already open before you installed or reloaded the extension show *Reload tab*.

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Development build in watch mode (inline source maps). Reload the extension in `chrome://extensions` after changes. |
| `npm run build` | Production build into `dist/`. |
| `npm run typecheck` | TypeScript, strict. |
| `npm test` | Unit and integration tests (Vitest, jsdom, fake-indexeddb). |
| `npm run test:e2e` | End-to-end run in real Chrome against real YouTube (see below). Build first. |
| `npm run package` | Production build, zipped for the Chrome Web Store: `release/shadowing-studio-<version>.zip`. |
| `npm run store-assets` | Regenerates the store screenshots and promo tiles in `store/` from a real session (build first). |
| `npm run icons` | Regenerates `public/icons/*.png`. |

**Stack**: TypeScript, React 19, Vite 8, Manifest V3, IndexedDB via [`idb`](https://github.com/jakearchibald/idb),
MediaRecorder/getUserMedia, `chrome.downloads`, `chrome.storage`, plain CSS with design tokens. The only
runtime dependencies besides React are `idb` (≈1 kB) and `fix-webm-duration` (writes the duration header
that MediaRecorder leaves out of WebM files; without it, players cannot seek).

**Layout**

```
src/
  content/     YouTube integration: page detection, LoopController, port bridge
  background/  service worker: side-panel behaviour, REC badge
  sidepanel/   React UI, PlayerConnection, RecorderService, export, settings
  permission/  one-click microphone permission page
  storage/     IndexedDB schema, migrations, repository
  shared/      message contracts, timestamps, validation, file names
tests/         Vitest suites
scripts/       build, package, e2e + store assets (shared Chrome harness), icons
store/         Chrome Web Store listing text and graphics
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, data flow and trade-offs.

## Publishing to the Chrome Web Store

[`store/LISTING.md`](store/LISTING.md) has everything the Developer Dashboard asks for: the listing text,
the single-purpose statement, a justification for each permission, the data-usage answers and a
pre-submit checklist. The privacy policy is [`PRIVACY.md`](PRIVACY.md), and the screenshots and promo
tiles are in `store/`. To publish: `npm run package`, then upload the zip.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `sidePanel` | The practice interface lives in Chrome's side panel. |
| `storage` | Small settings (mode, default language, auto-stop). |
| `downloads` | Exporting recordings into your Downloads folder. |
| `unlimitedStorage` | Keeps the browser from evicting your recordings when disk space is low. |
| Host access to `https://www.youtube.com/*` | The content script that reads and controls the YouTube player; lets the panel recognise YouTube tabs. |

The extension makes **no network requests of its own**, has no analytics or telemetry and loads no remote
code. Only the microphone is recorded: never the tab, the page audio or the screen. The microphone is
opened when you press record and released when you stop, and Chrome's mic indicator, the red REC chip and
a REC badge on the toolbar icon show it is active.

## Known limitations

- **YouTube internals**: the extension uses the standard `<video>` element plus three YouTube details
  (`video.html5-main-video`, the `ad-showing` class, the `yt-navigate-finish` event). Each has a fallback
  except ad detection: if YouTube renames that class, the loop may seek during an ad.
- **Ads** suspend the loop until the ad finishes.
- **Not supported**: live streams, Shorts, embedded players, `m.youtube.com`, `music.youtube.com`.
- **Loop precision** is about ±10 ms at 1× and within about 40 ms at 2× (measured). Seeking back may
  buffer briefly on slow connections.
- **Background tabs**: Chrome throttles timers in hidden tabs. Looping is precise in the visible tab,
  which is the normal case because the panel follows the active tab.
- **Speakers**: in Shadowing mode use headphones, otherwise the microphone also picks up the video sound
  from your speakers (echo cancellation helps only partly).
- **Closing the panel stops a recording** (it is recovered up to the last second on the next open).
- **Export location**: files go to your Downloads folder (an extension cannot write elsewhere without a
  file picker). If Chrome is set to *Ask where to save each file*, a Save dialog opens for each file.
- A video that is removed or made private stays in the library with its recordings; *Practice* then opens
  YouTube's "unavailable" page.

## Testing

### Automated (what is covered)

`npm test`: 107 tests, all passing at the time of writing.

- `time.test.ts`: timestamp parsing, formatting, round-trips, invalid input, segment validation and boundaries.
- `loop.test.ts`: start position, end detection (precise timer vs. timeupdate), seek back, repeated passes,
  0.5×/1×/1.5×/2×, play-once mode, cancellation, single-timer guarantee, no timers while paused, seeking or
  buffering, slow seeks, segment at the video end, ad suspension, detach cleanup, blocked playback.
- `bridge.test.ts` (jsdom): content-script ↔ panel messages, state on connect, commands and errors,
  SPA navigation, video changes detected from media events only, `<video>` element replacement, panel
  disconnect/reconnect, Shorts/live detection, ads.
- `recorder.test.ts`: MIME selection, start/stop, chunk persistence during recording, multiple attempts,
  permission denied / no microphone / busy, microphone disconnection, MediaRecorder errors, save failure
  hand-off, duration fix.
- `db.test.ts` (fake-indexeddb): blobs and metadata, attempt numbering, rename/notes, deletion (including
  cascade), counts and usage, crash recovery, schema creation and upgrade with an open older connection.
- `filename.test.ts`: sanitisation, reserved names, export paths, de-duplication, `info.json`.

`npm run test:e2e` drives your installed Chrome (via `playwright-core`; no browser download) against a real
YouTube video with Chrome's **fake microphone**. It runs 33 checks, all passing on the last run: install,
connect, timestamps, loop bounds at 0.5×/1×/2×, loop off, REC badge, shadowing auto-stop, listen & repeat
pause and record, decoded WebM/Opus audio with a duration header, playback, rename, compare, export folder
structure, delete, SPA navigation, no console errors, **library and recordings after restarting Chrome**,
and reopening a segment from the library. It handles YouTube's EU cookie dialog by declining non-essential
cookies. Set `E2E_HEADED=1` to watch it run, or `E2E_SHOTS=<dir>` to save screenshots.

The e2e run cannot cover the following: the real side panel (automation cannot click the toolbar icon, so
the panel page runs in its own window pinned to the YouTube tab with `?tabId=`), Chrome's real permission
prompt, a physical microphone, and Chrome's own crash recovery.

### Manual test procedure

Run this once per release in a normal Chrome profile:

1. **Install**: load `dist/` unpacked; there are no errors on the extension card.
2. **Side panel**: open a YouTube video, click the toolbar icon. The panel shows the title and
   *Connected*. Switch to a non-YouTube tab: the panel shows *Open a YouTube video*. Switch back: it
   reconnects.
3. **Old tab**: with a YouTube tab open, reload the extension in `chrome://extensions`. The panel shows
   *Reload tab*; click it and it reconnects.
4. **Microphone permission**: click *Enable microphone* or *Record attempt*. Allow it in the prompt, or in
   the helper tab if one opens. The chip shows *Microphone ready*. Block it in site settings: the panel
   shows *Microphone access is blocked* with *Open settings*.
5. **Segment and loop**: set start/end with ⌖ while playing; type an invalid end (before the start) and
   see the error. Turn on *Loop segment*, watch it at 0.5×, 1× and 2× (YouTube's speed menu) for a few
   passes; pause and resume from the YouTube controls; seek outside the segment (it snaps back).
6. **Shadowing**: with headphones, *Record attempt*. The REC chip, timer, the browser's mic indicator and
   the toolbar badge all show; it stops at the segment end. Record a second attempt: both are listed.
7. **Listen & repeat**: *Listen*: it pauses at the end and shows *Your turn*. *Record*, speak, *Stop
   recording*. *Listen again* works.
8. **Recordings**: play, pause, rename, add notes, *Compare*, delete (two clicks). Older attempts are
   unaffected.
9. **Interruptions**: start recording and close the side panel. Reopen it: *Recovered 1 recording*. Start
   recording and unplug the microphone: recording stops, and the audio so far is saved with a message.
10. **Navigation**: click a recommended video. The panel follows it and the segment resets; the previous
   video's segments are in the Library.
11. **Persistence**: quit Chrome completely and reopen it. The Library still lists the segments and the
   attempts play.
12. **Resume**: in the Library click *Practice*. The video opens at the segment, with the times filled in
   and the attempts listed.
13. **Export**: export one attempt, a segment and a video. Check `Downloads/Shadowing Studio/<Language>/<Video>/`
   for the expected names; files play in VLC or the browser and show a duration.
14. **Ads**: when a pre-roll or mid-roll ad plays, the panel shows *Ad playing — loop paused* and looping
   resumes after the ad.
