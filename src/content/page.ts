/**
 * YouTube page inspection. Everything YouTube-specific is in this file so it is easy to adapt
 * when YouTube changes. Each DOM detail has a fallback except the ad check.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export type PageKind = 'watch' | 'shorts' | 'other';

export function pageKind(href: string): PageKind {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return 'other';
  }
  if (url.hostname !== 'www.youtube.com') return 'other';
  if (url.pathname === '/watch' && VIDEO_ID_RE.test(url.searchParams.get('v') ?? '')) return 'watch';
  if (url.pathname.startsWith('/shorts/')) return 'shorts';
  return 'other';
}

/** Video id of a standard watch page, or null. */
export function videoIdFromUrl(href: string): string | null {
  if (pageKind(href) !== 'watch') return null;
  return new URL(href).searchParams.get('v');
}

/**
 * The main player's <video>. YouTube marks it with `html5-main-video`; if that class ever
 * disappears we fall back to the largest rendered <video> on the page (previews and ads in
 * the sidebar are much smaller).
 */
export function findMainVideo(doc: Document): HTMLVideoElement | null {
  const marked = doc.querySelector<HTMLVideoElement>('video.html5-main-video');
  if (marked) return marked;
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of Array.from(doc.querySelectorAll('video'))) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

/** Best effort: YouTube adds `ad-showing` to the player container while an ad plays. */
export function isAdShowing(video: HTMLVideoElement | null): boolean {
  return Boolean(video?.closest('.html5-video-player')?.classList.contains('ad-showing'));
}

/** Title from `document.title` ("(3) Some title - YouTube" → "Some title"). */
export function cleanTitle(raw: string): string {
  return raw.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '').trim();
}
