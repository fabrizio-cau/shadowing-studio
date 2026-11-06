// End-to-end check against real YouTube in a real Chrome, with a fake microphone.
//
//   npm run build && npm run test:e2e
//
// Env: CHROME_PATH (default: standard Windows/macOS/Linux install), E2E_VIDEO (default jNQXAC9IVRw),
//      E2E_HEADED=1 to watch it run.
//
// The Chrome harness (extension loading, consent, panel window) lives in scripts/harness.mjs.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as harness from './harness.mjs';
import { field, openYouTube, waitVideo } from './harness.mjs';

const VIDEO = process.env.E2E_VIDEO ?? 'jNQXAC9IVRw';
harness.assertReady();

const profile = mkdtempSync(path.join(tmpdir(), 'yss-e2e-profile-'));
const downloads = mkdtempSync(path.join(tmpdir(), 'yss-e2e-downloads-'));
const results = [];
/** E2E_SHOTS=<dir> saves screenshots of the panel at side-panel width. */
const shot = async (page, name) => process.env.E2E_SHOTS && page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}.png`), fullPage: true });
const consoleErrors = [];
let current = null;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function launch() {
  const launched = await harness.launch({ profile, downloads, headed: !!process.env.E2E_HEADED });
  current = launched.ctx;
  return launched;
}

const openPanel = (ctx, id) => harness.openPanel(ctx, id, { onError: (e) => consoleErrors.push(e) });

/** Samples video.currentTime for `ms`; returns min, max and how many times it jumped backwards. */
async function sample(page, ms) {
  return page.evaluate(async (ms) => {
    const v = document.querySelector('video.html5-main-video');
    let min = Infinity, max = -Infinity, wraps = 0, last = v.currentTime;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      await new Promise((r) => setTimeout(r, 30));
      const t = v.currentTime;
      if (v.seeking) continue;
      min = Math.min(min, t);
      max = Math.max(max, t);
      if (t < last - 0.5) wraps++;
      last = t;
    }
    return { min, max, wraps };
  }, ms);
}


async function readDb(panel) {
  return panel.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('shadowing-studio');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = (store) => new Promise((res) => (db.transaction(store).objectStore(store).getAll().onsuccess = (e) => res(e.target.result)));
    const recordings = await all('recordings');
    const segments = await all('segments');
    const drafts = await all('drafts');
    const out = [];
    for (const r of recordings.sort((a, b) => a.attempt - b.attempt)) {
      // Decode the audio for real, and check the <audio> element sees a finite duration (header fixed).
      const ctx = new OfflineAudioContext(1, 1, 48000);
      let decoded = 0;
      try {
        decoded = (await ctx.decodeAudioData(await r.blob.arrayBuffer())).duration;
      } catch {}
      const elDuration = await new Promise((res) => {
        const a = new Audio(URL.createObjectURL(r.blob));
        a.onloadedmetadata = () => res(a.duration);
        a.onerror = () => res(-1);
      });
      out.push({ attempt: r.attempt, mime: r.mimeType, bytes: r.blob.size, durationMs: r.durationMs, decoded, elDuration });
    }
    db.close();
    return { recordings: out, segments, drafts: drafts.length };
  });
}

try {
  // ---------------- Session 1 ----------------
  let { ctx, id } = await launch();
  check('Extension loads in Chrome via Load unpacked equivalent', !!id, `id ${id}`);
  const sw = ctx.serviceWorkers().find((w) => w.url().includes(id)) ?? (await ctx.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null));
  check('Service worker starts', !!sw);

  const yt = await openYouTube(ctx, `https://www.youtube.com/watch?v=${VIDEO}`);
  yt.on('pageerror', (e) => e.message.includes('Shadowing') && consoleErrors.push(`content: ${e.message}`));
  await waitVideo(yt);
  const panel = await openPanel(ctx, id);

  await panel.getByText('Connected').waitFor({ timeout: 20_000 });
  const title = await panel.locator('.video-title').textContent();
  check('Panel connects to the YouTube tab and shows the video', !!title, `title "${title}"`);

  check('Language field starts empty, with a placeholder', (await field(panel, 'Language').inputValue()) === '' && (await field(panel, 'Language').getAttribute('placeholder')) === 'e.g. Spanish');
  await field(panel, 'Language').fill('English');
  await field(panel, 'Start').fill('2');
  await field(panel, 'Start').press('Enter');
  await field(panel, 'End').fill('0:05');
  await field(panel, 'End').press('Enter');
  check('Timestamps normalise to HH:MM:SS', (await field(panel, 'Start').inputValue()) === '00:00:02' && (await field(panel, 'End').inputValue()) === '00:00:05');
  check('Segment length is displayed', await panel.getByText('Length: 3s').isVisible());

  await field(panel, 'End').fill('0:01');
  await field(panel, 'End').press('Enter');
  check('Invalid segment is rejected with a message', await panel.getByText('End time must be after the start time.').isVisible());
  await field(panel, 'End').fill('00:00:05');
  await field(panel, 'End').press('Enter');

  // The switch mirrors the content script's loop state, so it flips once the tab confirms.
  await panel.getByRole('switch').click();
  await panel.waitForFunction(() => document.querySelector('[role=switch]').checked);
  await yt.waitForFunction(() => !document.querySelector('video.html5-main-video').paused);
  let s = await sample(yt, 8000);
  check('Loop keeps playback inside the segment at 1x', s.min >= 1.95 && s.max <= 5.15 && s.wraps >= 2, JSON.stringify(s));
  await yt.evaluate(() => (document.querySelector('video.html5-main-video').playbackRate = 2));
  s = await sample(yt, 6000);
  check('Loop keeps playback inside the segment at 2x', s.min >= 1.95 && s.max <= 5.2 && s.wraps >= 3, JSON.stringify(s));
  await yt.evaluate(() => (document.querySelector('video.html5-main-video').playbackRate = 0.5));
  s = await sample(yt, 7000);
  check('Loop keeps playback inside the segment at 0.5x', s.min >= 1.95 && s.max <= 5.1 && s.wraps >= 1, JSON.stringify(s));
  await yt.evaluate(() => (document.querySelector('video.html5-main-video').playbackRate = 1));
  await panel.getByRole('switch').click();
  await panel.waitForFunction(() => !document.querySelector('[role=switch]').checked);
  s = await sample(yt, 3500);
  check('Turning the loop off lets playback continue past the end', s.max > 5.2, JSON.stringify(s));

  // Shadowing: record with auto-stop at the segment end.
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await panel.getByText('REC', { exact: true }).waitFor({ timeout: 10_000 });
  await shot(panel, '00-recording');
  const badge = await panel.evaluate(() => chrome.action.getBadgeText({}));
  check('Toolbar badge shows REC while recording', badge === 'REC', `badge "${badge}"`);
  await panel.getByText('Attempt 1 saved.').waitFor({ timeout: 15_000 });
  check('Shadowing attempt auto-stops at the segment end and is saved', true);
  let cleared = false;
  for (let i = 0; i < 20 && !cleared; i++) {
    cleared = (await panel.evaluate(() => chrome.action.getBadgeText({}))) === '';
    if (!cleared) await panel.waitForTimeout(250);
  }
  check('Badge clears after recording', cleared);
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await panel.getByText('Attempt 2 saved.').waitFor({ timeout: 15_000 });
  check('Second independent attempt saved', true);
  check('Video pauses when an auto-stopped attempt ends', await yt.evaluate(() => document.querySelector('video.html5-main-video').paused));
  const cardTop = async () => (await panel.locator('main .card').first().boundingBox()).y;
  const topWithToast = await cardTop();
  const closed = await panel.locator('.toast-region .banner').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false);
  check('Toast closes by itself and the layout does not move', closed && topWithToast === (await cardTop()), `top ${topWithToast} → ${await cardTop()}`);

  // Listen & repeat.
  await panel.getByRole('radio', { name: 'Listen & repeat' }).click();
  await panel.getByRole('button', { name: 'Listen' }).click();
  await panel.getByText('Your turn — record your imitation.').waitFor({ timeout: 15_000 });
  const pausedAt = await yt.evaluate(() => {
    const v = document.querySelector('video.html5-main-video');
    return { paused: v.paused, t: v.currentTime };
  });
  check('Listen & repeat pauses at the segment end', pausedAt.paused && pausedAt.t >= 4.9 && pausedAt.t <= 5.2, JSON.stringify(pausedAt));
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await panel.getByRole('button', { name: 'Stop recording' }).waitFor();
  await panel.waitForTimeout(2000);
  await panel.getByRole('button', { name: 'Stop recording' }).click();
  await panel.getByText('Attempt 3 saved.').waitFor({ timeout: 10_000 });
  check('Listen & repeat attempt saved', true);

  // Stored data.
  let db = await readDb(panel);
  check('Three recordings stored in IndexedDB', db.recordings.length === 3, JSON.stringify(db.recordings));
  check('Recordings are WebM/Opus with audio', db.recordings.every((r) => r.mime.startsWith('audio/webm') && r.bytes > 1000 && r.decoded > 0.5));
  check('WebM duration header present (seekable playback)', db.recordings.every((r) => Number.isFinite(r.elDuration) && r.elDuration > 0.5), db.recordings.map((r) => r.elDuration.toFixed?.(2)).join(', '));
  check('Shadowing attempts last about one segment pass', db.recordings.slice(0, 2).every((r) => r.durationMs > 2500 && r.durationMs < 4500), db.recordings.map((r) => r.durationMs).join(', '));
  check('No leftover drafts', db.drafts === 0);

  await shot(panel, '01-practice-repeat');
  // Recordings tab: playback, rename, selection, original.
  await panel.getByRole('tab', { name: /Recordings/ }).click();
  const rows = panel.locator('[role=listitem]');
  check('Recordings tab lists all attempts', (await rows.count()) === 3);
  const indexes = await rows.locator('.seg-num').allTextContents();
  check('Attempts show their index, newest first', indexes.join(',') === '#3,#2,#1', indexes.join(','));
  check('No attempt is tinted as "just saved"', (await panel.locator('[role=listitem].highlight').count()) === 0);
  await panel.getByRole('button', { name: 'Play Attempt 1' }).click();
  await panel.getByRole('button', { name: 'Pause Attempt 1' }).waitFor({ timeout: 5000 });
  await panel.getByRole('button', { name: 'Play Attempt 1' }).waitFor({ timeout: 10_000 });
  check('Attempt playback plays to the end', true);
  await panel.getByLabel('Name of Attempt 2').fill('Better rhythm');
  await panel.getByLabel('Name of Attempt 2').press('Enter');
  // The list shows the newest attempt first, so the last row is attempt 1.
  await rows.last().getByRole('button', { name: 'Notes' }).click();
  const selected = await panel.locator('.list-item.selected').count();
  check('Interacting with an attempt (Notes) highlights it alone', selected === 1 && (await rows.last().evaluate((el) => el.classList.contains('selected'))), `${selected} highlighted`);
  await panel.getByRole('button', { name: 'Play original' }).click();
  await yt.waitForFunction(() => !document.querySelector('video.html5-main-video').paused, null, { timeout: 10_000 });
  await yt.waitForFunction(() => document.querySelector('video.html5-main-video').paused, null, { timeout: 10_000 });
  const originalEnd = await yt.evaluate(() => document.querySelector('video.html5-main-video').currentTime);
  check('Play original plays the segment once and stops at its end', originalEnd >= 4.9 && originalEnd <= 5.2, `t=${originalEnd.toFixed(2)}`);

  await shot(panel, '02-recordings');
  // Export.
  await panel.getByRole('button', { name: 'Export all' }).click();
  await panel.getByText(/Exported 3 recordings/).waitFor({ timeout: 10_000 });
  for (let i = 0; i < 60; i++) {
    const done = await panel.evaluate(async () => {
      const items = await chrome.downloads.search({});
      return items.length >= 4 && items.every((d) => d.state === 'complete');
    });
    if (done) break;
    await panel.waitForTimeout(500);
  }
  const dls = await panel.evaluate(async () => (await chrome.downloads.search({})).map((d) => `${d.filename}~${d.state}~${d.error ?? ""}~${d.bytesReceived}`));
  const files = [];
  const walk = (dir) => readdirSync(dir).forEach((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : files.push(path.relative(downloads, path.join(dir, f)).replaceAll('\\', '/'))));
  walk(downloads);
  check('Export writes 3 audio files + info.json under Shadowing Studio/<Language>/<Video>/', files.length === 4 && files.every((f) => /^Shadowing Studio\/English\/[^/]+\/\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_.+(_Segment01_Attempt0[123]\.webm|_info\.json)$/.test(f)), files.join(' | ') || dls.join(' | '));

  // Delete one attempt (two clicks: arm, confirm).
  await panel.getByRole('button', { name: 'Delete Attempt 3' }).click();
  await panel.getByRole('button', { name: 'Delete', exact: true }).click();
  await panel.waitForFunction(() => document.querySelectorAll('[role=listitem]').length === 2);
  check('Deleting an attempt keeps the others', true);

  // Shadowing without auto-stop: loops while recording, pauses as soon as recording stops.
  await panel.getByRole('tab', { name: 'Practice' }).click();
  await panel.getByRole('radio', { name: 'Shadowing' }).click();
  await panel.getByLabel('Stop automatically at the end of the segment').uncheck();
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await panel.getByRole('button', { name: 'Stop recording' }).waitFor();
  s = await sample(yt, 4500);
  check('Without auto-stop, the segment keeps looping while recording', s.wraps >= 1 && s.min >= 1.95 && s.max <= 5.2 && (await panel.getByRole('button', { name: 'Stop recording' }).isVisible()), JSON.stringify(s));
  await panel.getByRole('button', { name: 'Stop recording' }).click();
  await panel.getByText(/Attempt \d+ saved\./).waitFor({ timeout: 10_000 });
  check('Video pauses when the recording is stopped', await yt.evaluate(() => document.querySelector('video.html5-main-video').paused));
  await panel.getByLabel('Stop automatically at the end of the segment').check();
  // Remove that extra attempt so later checks keep their counts.
  await panel.getByRole('tab', { name: /Recordings/ }).click();
  await panel.getByRole('button', { name: /^Delete / }).first().click();
  await panel.getByRole('button', { name: 'Delete', exact: true }).click();
  await panel.waitForFunction(() => document.querySelectorAll('[role=listitem]').length === 2);

  // SPA navigation to another video.
  const otherHref = await yt.evaluate((current) => {
    const a = [...document.querySelectorAll('a[href*="/watch?v="]')].find((x) => !x.href.includes(current) && x.offsetParent);
    return a?.getAttribute('href') ?? null;
  }, VIDEO);
  if (otherHref) {
    await yt.evaluate((href) => document.querySelector(`a[href="${href}"]`).click(), otherHref);
    await yt.waitForURL((u) => !u.href.includes(VIDEO), { timeout: 20_000 });
    await panel.getByRole('tab', { name: 'Practice' }).click();
    await panel.waitForFunction((t) => document.querySelector('.video-title')?.textContent !== t, title, { timeout: 20_000 });
    check('SPA navigation: panel follows the new video and resets the segment', (await field(panel, 'Start').inputValue()) === '', await panel.locator('.video-title').textContent());
  } else {
    check('SPA navigation (skipped: no other video link rendered)', true, 'verify manually');
  }

  check('No console errors in the panel', consoleErrors.length === 0, consoleErrors.join(' | '));
  await ctx.close();

  // ---------------- Session 2: browser restart ----------------
  ({ ctx, id } = await launch());
  const home = await openYouTube(ctx, 'https://www.youtube.com/');
  await home.waitForLoadState('domcontentloaded');
  const panel2 = await openPanel(ctx, id);
  await panel2.getByRole('tab', { name: 'Library' }).click();
  await panel2.getByText('2 attempts').waitFor({ timeout: 10_000 });
  check('After restarting Chrome, the library still has the segment and its attempts', true);
  await shot(panel2, '03-library');
  db = await readDb(panel2);
  check('Recordings survive a browser restart', db.recordings.length === 2 && db.recordings.every((r) => r.decoded > 0.5));

  await panel2.getByRole('button', { name: 'Practice', exact: true }).click();
  await panel2.waitForFunction(() => document.querySelector('label.field input')?.value === '00:00:02' || [...document.querySelectorAll('input')].some((i) => i.value === '00:00:02'), null, { timeout: 60_000 });
  const ytTab = ctx.pages().find((p) => p.url().includes(`v=${VIDEO}`));
  check('Reopening a saved segment opens its video and restores the times', !!ytTab, ytTab?.url());
  if (ytTab) {
    // Read the position right away (consent was answered in session 1; the video autoplays on).
    await ytTab.waitForFunction(() => document.querySelector('video.html5-main-video')?.readyState >= 1, null, { timeout: 30_000 });
    const t = await ytTab.evaluate(() => document.querySelector('video.html5-main-video').currentTime);
    check('Video is positioned at the segment start', t >= 1.9 && t < 5.1, `t=${t.toFixed(2)}`);
  }
  check('No console errors after restart', consoleErrors.length === 0, consoleErrors.join(' | '));
  await ctx.close();
} catch (err) {
  check('Unexpected failure', false, err instanceof Error ? err.stack : String(err));
  for (const p of current?.pages() ?? []) {
    const text = await p.evaluate(() => document.body?.innerText.slice(0, 600)).catch(() => '?');
    console.log(`--- page ${p.url()}
${text}`);
  }
} finally {
  await current?.close().catch(() => undefined);
  for (const dir of [profile, downloads]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      console.warn(`Could not remove ${dir}`);
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
