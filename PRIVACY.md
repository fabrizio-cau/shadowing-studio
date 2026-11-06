# Privacy Policy — Shadowing Studio for YouTube

_Last updated: 6 November 2026_

Shadowing Studio for YouTube ("the extension") is a language-practice tool. It is built to work
entirely on your own computer.

## What the extension handles

| Data | Where it stays | Why |
| --- | --- | --- |
| **Microphone recordings** you make by pressing *Record* | In your browser's local storage (IndexedDB) on your computer | So you can replay, compare and export your practice attempts |
| **Practice segments**: video ID, video title and URL, start/end times, a language label you choose | Same local storage | To build your practice library |
| **Names and notes** you add to attempts | Same local storage | Your own annotations |
| **Settings** (practice mode, default language, auto-stop) | `chrome.storage.local` on your computer | To remember your preferences |

## What the extension does not do

- It does **not** send any of this data anywhere. The extension makes no network requests of its own,
  has no servers, and contains no analytics, telemetry, advertising or tracking code.
- It does **not** record anything except your microphone, and only while you are recording. It never
  captures the video's audio, the tab or your screen.
- It does **not** use your microphone without your action. Recording starts only when you press a
  record button, and Chrome's microphone indicator, a red "REC" label and a toolbar badge show it.
- It does **not** sell, share or transfer data to third parties, and does not use data for purposes
  unrelated to practising with your recordings.
- It does **not** read your YouTube account, watch history, comments or any page other than the
  YouTube page in the active tab.

YouTube itself is a Google service. When you watch videos, YouTube's own privacy policy applies to
your use of YouTube; the extension does not change what YouTube collects.

## Exports

When you choose *Export*, the extension saves audio files (and a small `info.json` describing your
segments) into your computer's Downloads folder using Chrome's download feature. Those files are then
yours to keep, move or delete.

## Deleting your data

- Delete individual attempts or whole segments in the extension's *Recordings* and *Library* tabs.
- Removing the extension from Chrome deletes all its stored recordings and settings.
- Exported files in your Downloads folder are not affected by either; delete them as you would any file.

## Permissions

| Permission | Purpose |
| --- | --- |
| `sidePanel` | Shows the practice interface in Chrome's side panel. |
| `storage` | Saves your settings locally. |
| `downloads` | Saves exported recordings to your Downloads folder when you ask. |
| `unlimitedStorage` | Keeps the browser from deleting your recordings when disk space runs low. |
| Access to `www.youtube.com` | Reads and controls the YouTube video player for looping and playback. |
| Microphone (asked by Chrome when you first record) | Records your voice for practice attempts. |

## Children

The extension does not knowingly collect any personal information from anyone, including children,
because it collects no information at all outside your own device.

## Changes

If this policy changes, the new version will be published at this address with a new date.

## Contact

Questions: open an issue at <https://github.com/fabrizio-cau/shadowing-studio/issues>.
