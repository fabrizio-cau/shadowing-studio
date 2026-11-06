export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/** Watches the extension origin's microphone permission. Returns an unsubscribe function. */
export function watchMicPermission(onChange: (state: MicPermission) => void): () => void {
  let status: PermissionStatus | null = null;
  let cancelled = false;
  const update = () => status && onChange(status.state as MicPermission);
  navigator.permissions
    .query({ name: 'microphone' as PermissionName })
    .then((s) => {
      if (cancelled) return;
      status = s;
      update();
      s.addEventListener('change', update);
    })
    .catch(() => onChange('unknown'));
  return () => {
    cancelled = true;
    status?.removeEventListener('change', update);
  };
}

/**
 * Side panels cannot always show Chrome's permission prompt. The helper page is a normal tab of
 * the same extension origin, so a grant there applies to the panel too.
 */
export function openPermissionPage(): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({ url: chrome.runtime.getURL('permission/index.html') });
}

/** For a permission the user blocked: Chrome's settings page for this extension's origin. */
export function openMicSettings(): Promise<chrome.tabs.Tab> {
  const site = encodeURIComponent(`chrome-extension://${chrome.runtime.id}`);
  return chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${site}` });
}
