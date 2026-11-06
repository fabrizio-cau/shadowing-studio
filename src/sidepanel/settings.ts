import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}
