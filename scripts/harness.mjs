// Shared Chrome automation for scripts/e2e.mjs and scripts/store-assets.mjs.
//
// Branded Chrome ≥137 ignores --load-extension, so the extension is loaded through the CDP
// `Extensions.loadUnpacked` method (needs --enable-unsafe-extension-debugging). The side panel
// page is opened in its own window pinned to the YouTube tab via `?tabId=` because automation
// cannot click the toolbar button. Chrome's fake media device stands in for the microphone.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

export const DIST = path.resolve('dist');
export const CHROME =
  process.env.CHROME_PATH ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].find((p) => existsSync(p));

export function assertReady() {
  if (!existsSync(path.join(DIST, 'manifest.json'))) throw new Error('Run `npm run build` first.');
  if (!CHROME) throw new Error('Chrome not found; set CHROME_PATH.');
}

/** Launches Chrome on `profile` with the extension loaded; downloads go to `downloads`. */
export async function launch({ profile, downloads, headed = false, viewport = { width: 1280, height: 800 } }) {
  // CDP download overrides rename files to GUIDs, so instead point the profile's own download
  // directory at a temp folder and let Chrome behave normally (honouring the extension's paths).
  const prefs = path.join(profile, 'Default', 'Preferences');
  if (!existsSync(prefs)) {
    mkdirSync(path.dirname(prefs), { recursive: true });
    writeFileSync(prefs, JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  }
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: !headed,
    locale: 'en-US',
    viewport,
    acceptDownloads: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--enable-unsafe-extension-debugging',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const cdp = await ctx.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: DIST });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  return { ctx, id };
}

export async function openYouTube(ctx, url) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('consent.')) {
    // Decline non-essential cookies.
    await page.getByRole('button', { name: /reject all/i }).first().click();
    await page.waitForURL(/youtube\.com\/(watch|$)/);
  }
  return page;
}

/**
 * Waits until the main video has metadata, no ad is showing and the cookie dialog is gone.
 * EU visitors get an in-page consent dialog (sometimes several seconds late) that keeps the
 * player paused until answered; we decline non-essential cookies.
 */
export async function waitVideo(page) {
  const reject = page.locator('button:has-text("Reject all"), button[aria-label^="Reject"]').first();
  let answered = false;
  for (let i = 0; i < 120; i++) {
    // Click once: a second click on the closing dialog can land on a recommended video behind it.
    if (!answered && (await reject.isVisible().catch(() => false))) {
      answered = true;
      await reject.click({ timeout: 3000 }).catch(() => undefined);
    }
    const ready = await page.evaluate(() => {
      const v = document.querySelector('video.html5-main-video');
      return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && !document.querySelector('.ad-showing');
    }).catch(() => false);
    if (process.env.E2E_DEBUG) console.log('wait', i, ready, await page.evaluate(() => { const v = document.querySelector('video.html5-main-video'); return `${location.search} t=${v?.currentTime.toFixed(1)} d=${v?.duration} ad=${!!document.querySelector('.ad-showing')}`; }).catch((e) => e.message.slice(0, 60)));
    // Hold the (short) clip at the start so YouTube does not autoplay the next video meanwhile.
    if (ready) await page.evaluate(() => { const v = document.querySelector('video.html5-main-video'); v.pause(); if (v.currentTime > 1) v.currentTime = 0; }).catch(() => undefined);
    if (ready && i >= 16) return; // give a late consent dialog ~8 s to appear
    await page.waitForTimeout(500);
  }
  const why = await page.evaluate(() => { const v = document.querySelector('video.html5-main-video'); return JSON.stringify({ found: !!v, rs: v?.readyState, d: v?.duration, t: v?.currentTime, ad: !!document.querySelector('.ad-showing'), url: location.href }); });
  throw new Error(`The YouTube video did not become ready: ${why}`);
}

/**
 * Opens the side-panel page pinned to the first YouTube tab, in its own window so the YouTube
 * tab stays visible as it is next to a real side panel (Chrome throttles media in hidden tabs).
 */
export async function openPanel(ctx, id, { onError, width = 400, height = 900, ytUrlPrefix = 'https://www.youtube.com/*' } = {}) {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${id}/permission/index.html`);
  const tabId = await helper.evaluate(async (pattern) => (await chrome.tabs.query({ url: pattern }))[0]?.id, ytUrlPrefix);
  const opened = ctx.waitForEvent('page');
  await helper.evaluate(({ url, width, height }) => chrome.windows.create({ url, width: width + 20, height }), { url: `chrome-extension://${id}/sidepanel/index.html?tabId=${tabId}`, width, height });
  const panel = await opened;
  if (onError) {
    panel.on('console', (m) => m.type() === 'error' && onError(`panel: ${m.text()}`));
    panel.on('pageerror', (e) => onError(`panel exception: ${e.message}`));
  }
  await panel.waitForLoadState();
  await panel.setViewportSize({ width, height });
  await helper.close();
  return panel;
}

/** The text input of a labelled field in the panel ("Start", "End", "Language"). */
export const field = (panel, label) => panel.locator(`label.field:has(.field-label:text-is("${label}")) input`).first();
