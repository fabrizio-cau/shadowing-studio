# Shadowing Studio — Architecture

## Goals and constraints

A local-first Manifest V3 extension. Everything except the YouTube video itself works offline.
No accounts, no network calls of our own, no remote code, no audio capture other than the
microphone.

The design is driven by five platform facts:

| Fact | Consequence |
| --- | --- |
| MV3 service workers are suspended after ~30 s idle and lose memory. | The service worker holds **no** practice state. It only configures the side panel and keeps the toolbar "REC" badge honest. |
| `URL.createObjectURL` is not available in a service worker. | Exports (blob → download) run in the side panel document, which can create blob URLs. |
| A popup is destroyed when it loses focus. | The practice UI is a **side panel**, a full extension document that stays open while the user interacts with YouTube. |
| Content scripts run in an isolated world but share the DOM. | The content script can control the page's `<video>` element through standard `HTMLMediaElement` APIs, without touching YouTube's internal JS player API. |
| Extension pages share one origin (`chrome-extension://<id>`). | IndexedDB, microphone permission and `chrome.*` APIs are all available in the side panel and the permission helper page. |

## Components

```
┌──────────────── YouTube tab ────────────────┐        ┌──────────── Side panel (React) ─────────────┐
│ content script (src/content)                │  Port  │ PlayerConnection  ─ tracks active tab,     │
│  • page.ts       find watch page + <video>  │◄──────►│                     (re)connects the port  │
│  • loop.ts       LoopController (segment    │ "yss-  │ RecorderService   ─ getUserMedia +         │
│                  loop / play-once)          │ player"│                     MediaRecorder          │
│  • index.ts      state pushes, commands     │        │ storage/db.ts     ─ IndexedDB (idb)        │
└─────────────────────────────────────────────┘        │ export.ts         ─ chrome.downloads        │
                                                       └───────────────┬─────────────────────────────┘
┌──────── Service worker (src/background) ────┐                        │ Port "yss-panel"
│  • openPanelOnActionClick                    │◄───────────────────────┘ (recording flag)
│  • "REC" badge, cleared when panel port dies │
└──────────────────────────────────────────────┘
┌──── permission.html (src/permission) ───────┐
│ one-click microphone grant in a normal tab   │
└──────────────────────────────────────────────┘
```

### Content script (`src/content`)

* Injected on `https://www.youtube.com/*` (all pages, because YouTube navigates as a SPA and
  a user may land on the home page first).
* **Video discovery** uses `video.html5-main-video` with a fallback to the largest `<video>` on
  the page. Only the page URL decides whether the page is a supported watch page
  (`/watch?v=<id>`). Shorts, live streams (infinite duration) and other pages are reported as
  unsupported.
* **Change detection is event-driven**: media events do not bubble but they *can be captured*,
  so a single `document.addEventListener('loadstart' | 'loadedmetadata' | 'emptied', …, true)`
  notices a new video in the existing element or a brand-new element. `yt-navigate-finish`
  (a DOM event YouTube dispatches after SPA navigation) and `popstate` are extra triggers.
  If YouTube stops dispatching `yt-navigate-finish`, media events still cover video changes.
* **LoopController** (`loop.ts`) is a pure class over a minimal `MediaLike` interface so it can
  be unit-tested. It listens to `timeupdate`, `play`, `playing`, `seeking`, `seeked`,
  `ratechange`, `waiting`. `timeupdate` fires only every ~250 ms, which would overshoot the
  end point, so when the end is less than 0.6 s of *real* time away
  (`(end − t) / playbackRate`) it arms **one** precise `setTimeout`. There is only ever one
  timer (it is cleared before re-arming), no timer while paused/buffering/seeking, and
  no polling. Modes: `off`, `loop` (seek back to start) and `once` (pause at end, then switch
  off so pressing play does not immediately pause again).
* Ads: while the player has the `ad-showing` class the loop is suspended (best-effort; the class
  is the only signal available without YouTube's private API).
* State (`PlayerState`) is pushed to the panel on media events; commands arrive on the same port.
  The content script is the source of truth for playback and loop state, so the loop keeps
  working if the panel is closed and is reported correctly when the panel reconnects.

### Side panel (`src/sidepanel`)

* Tabs: **Practice**, **Recordings**, **Library**.
* `PlayerConnection` follows the active tab of the panel's window (`tabs.onActivated`,
  `tabs.onUpdated`) and opens `chrome.tabs.connect(tabId, { name: 'yss-player' })`. If the
  connection fails (tab opened before the extension was installed/reloaded) the UI offers
  "Reload tab" rather than requesting the `scripting` permission.
* `RecorderService` owns the microphone lifecycle. The stream is acquired on an explicit click
  and released as soon as recording stops, so Chrome's mic indicator is only on while recording.
* The panel is the **persistent recording context**. A popup would kill recordings; an offscreen
  document would keep recording while no UI is visible, which conflicts with "no hidden
  microphone activation". If the panel is closed mid-recording the recording is not lost:
  see *crash safety* below.

### Service worker (`src/background`)

Stateless by design. It sets `openPanelOnActionClick`, and shows a red `REC` badge while the
panel reports that it is recording. The panel holds a port open while it lives; when the port
disconnects (panel closed/crashed) the badge is cleared. If the worker is restarted, the panel
reconnects and re-sends its flag.

### Storage (`src/storage`)

IndexedDB via [`idb`](https://github.com/jakearchibald/idb) (≈1 kB; promise wrapper with typed
schema and versioned upgrades). Dexie was not needed.

| Store | Key | Indexes | Content |
| --- | --- | --- | --- |
| `segments` | `id` | `videoId`, `language` | video id/url/title, language, start/end, number, attempt counter |
| `recordings` | `id` | `segmentId` | attempt number, created time, duration, MIME type, **Blob**, name, notes |
| `drafts` | `id` | – | metadata of a recording in progress |
| `chunks` | `[recordingId, seq]` | `recordingId` | MediaRecorder chunks of a recording in progress |

* Migrations are an ordered list applied in `upgrade(oldVersion)`; each step only adds.
* Attempt numbers come from a per-segment counter incremented in the same transaction that saves
  the recording, so deleting an attempt never causes a number to be reused.
* **Crash safety**: `MediaRecorder.start(1000)` emits a chunk every second; each chunk is written
  to `chunks` immediately. On a normal stop the chunks are assembled, the WebM duration header is
  added (`fix-webm-duration`; MediaRecorder WebM files have no duration, which breaks seeking),
  and the recording + chunk cleanup happen in one transaction. On panel start-up any leftover
  draft is assembled into a recording marked "recovered".
* Settings (mode, default language, auto-stop) live in `chrome.storage.local`. No blobs there.
* `unlimitedStorage` avoids quota eviction of recordings; usage is shown via
  `navigator.storage.estimate()`.

### Export (`src/sidepanel/export.ts`)

`chrome.downloads.download({ url: blobURL, filename: 'Shadowing Studio/<Language>/<Video>/<file>', conflictAction: 'uniquify' })`.
Paths are relative to the user's Downloads folder — the only location an extension can write to
without a picker. File names are sanitised (Windows-reserved characters and names, trailing dots,
length). A segment or a whole video can be exported (all attempts + an `info.json`).
The File System Access API was considered for "pick a folder", but its permission does not
persist across sessions without re-prompting, and the downloads API already satisfies the
requirement, so it was left out.

### Shared (`src/shared`)

Timestamp parsing/formatting (`HH:MM:SS`; segment starts round down and ends round up to whole seconds), segment validation, filename sanitisation and the
typed message contracts (`messages.ts`) that both ends of each port import.

## Practice modes

* **Shadowing (simultaneous)**: *Record* starts the recorder, then seeks to the segment
  start and plays with the loop on. With *auto-stop* (default) the attempt ends when the segment
  ends; otherwise it loops until the user stops it. The video pauses whenever the attempt ends
  (stop, auto-stop or an error). Only the microphone is recorded; headphones are recommended
  so the speakers don't leak into the mic.
* **Listen & repeat**: *Listen* plays the segment once (`once` mode pauses at the end). The panel
  then prompts *Record imitation*; after stopping, *Listen again* restarts the cycle.

## Microphone permission

A side panel may not be able to display the permission prompt. The panel first tries
`getUserMedia`; if Chrome refuses without asking, the panel opens `permission.html` in a normal
tab where the user grants access once. The permission belongs to the extension origin, so the
panel can use it from then on (it listens to `permissions.query({name:'microphone'})` changes).

## Permissions

| Permission | Why |
| --- | --- |
| `sidePanel` | The practice UI. |
| `storage` | Small settings in `chrome.storage.local`. |
| `downloads` | Exporting recordings to the Downloads folder. |
| `unlimitedStorage` | Keep IndexedDB recordings from being evicted under storage pressure. |
| host `https://www.youtube.com/*` | Content script on YouTube; lets the panel read the active tab URL. |

Not requested: `tabs`, `scripting`, `activeTab`, `offscreen`, `tabCapture`, any other host.

## Testing seams

* `LoopController` takes a `MediaLike` and injectable timers; `PlayerBridge` takes a document,
  window and port-like objects; `RecorderService` takes its media, recorder and store
  dependencies; `ShadowingStore` takes a database name and migration list.
* `sidepanel/index.html?tabId=N` pins the panel to one tab. It exists only so the end-to-end
  script can open the panel as a page, because automation cannot click the toolbar button.

## Known limitations

* YouTube DOM: `video.html5-main-video`, `.ad-showing` and `yt-navigate-finish` are YouTube
  implementation details. Each has a fallback, but the ad check has none (the loop may seek during
  an ad if YouTube renames the class).
* Loop accuracy, measured against real YouTube: the end overshoots by ≤ 10 ms at 1× and ≤ 40 ms
  at 2× (timer resolution × playback rate, plus seek latency). Seeking back may briefly buffer on
  slow connections.
* YouTube's own app pauses the player while its cookie-consent dialog is open; extension commands
  cannot (and should not) override that.
* Background tabs throttle timers to 1 Hz; the loop is accurate only in the visible tab
  (the normal case since the panel follows the active tab).
* Live streams and Shorts are not supported.
* Closing the panel stops an in-progress recording (recovered on next open, up to the last
  1-second chunk).
* If Chrome is set to "Ask where to save each file", every exported file opens a Save dialog.
