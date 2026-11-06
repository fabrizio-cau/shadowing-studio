// Generates Chrome Web Store graphics into store/:
//   npm run build && npm run store-assets
// - four 1280×800 screenshots: the YouTube tab (880 px) with the side panel (400 px) beside it,
//   captured from a real session with real recordings (Chrome's fake microphone);
// - promo tiles (440×280 and 1400×560) rendered from HTML.
// Env: E2E_VIDEO to use another video, E2E_HEADED=1 to watch.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertReady, field, launch, openPanel, openYouTube, waitVideo } from './harness.mjs';

assertReady();
const VIDEO = process.env.E2E_VIDEO ?? 'jNQXAC9IVRw';
const OUT = path.resolve('store');
const W = 1280, H = 800, PANEL = 400;
mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(path.join(tmpdir(), 'yss-assets-profile-'));
const downloads = mkdtempSync(path.join(tmpdir(), 'yss-assets-downloads-'));
const { ctx, id } = await launch({ profile, downloads, headed: !!process.env.E2E_HEADED, viewport: { width: W - PANEL, height: H } });

try {
  const yt = await openYouTube(ctx, `https://www.youtube.com/watch?v=${VIDEO}`);
  await waitVideo(yt);
  const panel = await openPanel(ctx, id, { width: PANEL, height: H });
  await panel.getByText('Connected').waitFor({ timeout: 20_000 });

  // Toasts close by themselves after 2 s; keep them out of the screenshots.
  const toastGone = () => panel.locator('.toast-region .banner').waitFor({ state: 'detached', timeout: 10_000 });

  const setSegment = async (start, end) => {
    await field(panel, 'Start').fill(start);
    await field(panel, 'Start').press('Enter');
    await field(panel, 'End').fill(end);
    await field(panel, 'End').press('Enter');
  };

  // A second saved segment makes the library look like real use.
  await field(panel, 'Language').fill('English');
  await setSegment('00:00:08', '00:00:12');
  await panel.getByRole('button', { name: 'Save' }).click();
  await panel.getByText(/Segment #1 saved/).waitFor();
  // Retiming a saved segment without attempts would update it; New starts a new one.
  await panel.getByRole('button', { name: 'New', exact: true }).click();

  await setSegment('00:00:02', '00:00:05');
  for (const n of [1, 2]) {
    await panel.getByRole('button', { name: 'Record', exact: true }).click();
    await panel.getByText(`Attempt ${n} saved.`).waitFor({ timeout: 15_000 });
  }
  await toastGone();

  // Shadowing recordings leave the loop on, so set the switch to a state rather than toggling.
  const setLoop = async (on) => {
    if ((await panel.getByRole('switch').isChecked()) !== on) await panel.getByRole('switch').click();
    await panel.waitForFunction((on) => document.querySelector('[role=switch]').checked === on, on);
  };

  // 1. Practice: looping, mid-recording.
  await setLoop(true);
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await panel.getByText('REC', { exact: true }).waitFor();
  await panel.waitForTimeout(1600);
  await compose(yt, panel, 'screenshot-1-practice.png', { scrollToBottom: true });
  await panel.getByRole('button', { name: 'Stop recording' }).click();
  await panel.getByText('Attempt 3 saved.').waitFor({ timeout: 10_000 });
  await setLoop(false);
  await yt.evaluate(() => document.querySelector('video.html5-main-video').pause());

  // 2. Recordings: named attempt with a note, one playing.
  await toastGone();
  await panel.getByRole('tab', { name: /Recordings/ }).click();
  await panel.getByLabel('Name of Attempt 1').fill('First try');
  await panel.getByLabel('Name of Attempt 1').press('Enter');
  await panel.getByLabel('Name of Attempt 3').fill('Better rhythm');
  await panel.getByLabel('Name of Attempt 3').press('Enter');
  const notes = panel.getByRole('button', { name: 'Notes' }).first();
  await notes.click();
  await panel.getByLabel('Notes for Attempt 3').fill('Linking "the" + "cool thing" is smoother now. Stress on "really".');
  await panel.getByLabel('Notes for Attempt 3').blur();
  // Store images only: hide Chrome's spell-check underlines in the note.
  await panel.evaluate(() => document.querySelectorAll('textarea').forEach((t) => (t.spellcheck = false)));
  await panel.getByRole('button', { name: 'Play Attempt 2' }).click();
  await panel.waitForTimeout(900);
  await compose(yt, panel, 'screenshot-2-recordings.png');

  // 3. Library.
  await panel.getByRole('tab', { name: 'Library' }).click();
  await panel.getByText('3 attempts').waitFor();
  await panel.getByText('0 attempts').waitFor();
  await compose(yt, panel, 'screenshot-3-library.png');

  // 4. Listen & repeat: the segment played once and paused; the user's turn to record.
  await panel.getByRole('tab', { name: 'Practice' }).click();
  await panel.getByRole('radio', { name: 'Listen & repeat' }).click();
  await panel.getByRole('button', { name: 'Listen', exact: true }).click();
  await panel.getByText('Your turn — record your imitation.').waitFor({ timeout: 15_000 });
  await compose(yt, panel, 'screenshot-4-listen-repeat.png', { scrollToBottom: true });

  // Promo tiles.
  const icon = `data:image/png;base64,${readFileSync('public/icons/icon128.png').toString('base64')}`;
  await renderTile(440, 280, 'promo-small-440x280.png', icon, false);
  await renderTile(1400, 560, 'promo-marquee-1400x560.png', icon, true);
  console.log(`Store assets written to ${path.relative(process.cwd(), OUT)}/`);
} finally {
  await ctx.close();
  for (const dir of [profile, downloads]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      console.warn(`Could not remove ${dir}`);
    }
  }
}

/** Places the YouTube tab and the panel side by side, as Chrome shows a docked side panel. */
async function compose(yt, panel, file, { scrollToBottom = false } = {}) {
  await panel.evaluate((bottom) => window.scrollTo(0, bottom ? document.body.scrollHeight : 0), scrollToBottom);
  const left = (await yt.screenshot()).toString('base64');
  const right = (await panel.screenshot()).toString('base64');
  const page = await ctx.newPage();
  await page.setViewportSize({ width: W, height: H });
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;display:flex;background:#fff}
    img{display:block;height:${H}px}
    .panel{border-left:1px solid #d4d4da;box-sizing:border-box}
  </style>
  <img src="data:image/png;base64,${left}" width="${W - PANEL}">
  <img class="panel" src="data:image/png;base64,${right}" width="${PANEL}">`);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.close();
  console.log(`  ${file}`);
}

async function renderTile(width, height, file, icon, large) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width, height });
  const s = large ? 2.2 : 1;
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
    body{font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;background:linear-gradient(135deg,#4f46e5 0%,#3730a3 100%);color:#fff;
      display:flex;align-items:center;gap:${24 * s}px;padding:0 ${36 * s}px;box-sizing:border-box}
    .logo{background:#fff;border-radius:${20 * s}px;padding:${8 * s}px;box-shadow:0 ${6 * s}px ${20 * s}px rgb(0 0 0/.25);flex:none;display:flex}
    .art{width:${64 * s}px;height:${64 * s}px;overflow:hidden;position:relative}
    /* icon128.png has 16 px of transparent padding (store icon guideline); show only the artwork. */
    img{position:absolute;width:${(64 * s * 128) / 96}px;height:${(64 * s * 128) / 96}px;left:${(-64 * s * 16) / 96}px;top:${(-64 * s * 16) / 96}px}
    h1{margin:0 0 ${8 * s}px;font-size:${30 * s}px;line-height:1.1;font-weight:700;letter-spacing:-.01em}
    p{margin:0;font-size:${15 * s}px;line-height:1.35;color:#e0e7ff;max-width:${large ? 720 : 260}px}
    .steps{margin-top:${12 * s}px;display:flex;gap:${8 * s}px;flex-wrap:wrap}
    .steps span{font-size:${11 * s}px;font-weight:600;background:rgb(255 255 255/.16);border-radius:999px;padding:${3 * s}px ${9 * s}px}
  </style>
  <div class="logo"><div class="art"><img src="${icon}"></div></div><div>
    <h1>Shadowing Studio</h1>
    <p>Loop any sentence on YouTube, record yourself and compare.</p>
    <div class="steps"><span>Loop</span><span>Record</span><span>Compare</span>${large ? '<span>Private, on your device</span>' : ''}</div>
  </div>`);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.close();
  console.log(`  ${file}`);
}
