import { PLAYER_PORT, type PlayerCommand, type PlayerEvent } from '../shared/messages';

export type Connection =
  | { kind: 'connecting' }
  | { kind: 'no-tab' }
  | { kind: 'not-youtube'; tabId: number }
  /** A YouTube tab without a live content script (opened before install or extension reload). */
  | { kind: 'needs-reload'; tabId: number }
  | { kind: 'connected'; tabId: number };

export interface PlayerConnectionOptions {
  onEvent: (event: PlayerEvent) => void;
  onConnection: (connection: Connection) => void;
  /** Pin to one tab instead of following the active tab (used by automated tests). */
  fixedTabId?: number;
}

const isYouTube = (url: string | undefined) => !!url && /^https:\/\/www\.youtube\.com\//.test(url);

/**
 * Follows the active tab of the side panel's window and keeps a port open to the content script
 * in it. Tabs whose URL we cannot read (no host permission) are, by definition, not YouTube.
 */
export class PlayerConnection {
  private port: chrome.runtime.Port | null = null;
  private tabId: number | null = null;
  private windowId: number | null = null;
  private connection: Connection = { kind: 'connecting' };
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly options: PlayerConnectionOptions) {}

  async start(): Promise<void> {
    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (this.options.fixedTabId === undefined && info.windowId === this.windowId) void this.target(info.tabId);
    };
    const onUpdated = (tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tabId !== this.tabId) return;
      // A full page load replaces the content script; SPA navigations keep the port.
      if (change.status === 'complete' || (change.url && !this.port)) this.connect(tab);
      else if (change.url && !isYouTube(change.url)) this.connect(tab);
    };
    const onRemoved = (tabId: number) => {
      if (tabId === this.tabId) {
        this.disconnect();
        this.tabId = null;
        this.set({ kind: 'no-tab' });
      }
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    this.cleanups.push(
      () => chrome.tabs.onActivated.removeListener(onActivated),
      () => chrome.tabs.onUpdated.removeListener(onUpdated),
      () => chrome.tabs.onRemoved.removeListener(onRemoved),
    );

    if (this.options.fixedTabId !== undefined) {
      await this.target(this.options.fixedTabId);
      return;
    }
    const win = await chrome.windows.getCurrent();
    this.windowId = win.id ?? null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (tab?.id !== undefined) await this.target(tab.id);
    else this.set({ kind: 'no-tab' });
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    for (const c of this.cleanups) c();
  }

  get activeTabId(): number | null {
    return this.tabId;
  }

  get current(): Connection {
    return this.connection;
  }

  /** Sends a command; returns false if no content script is connected. */
  send(command: PlayerCommand): boolean {
    if (!this.port) return false;
    try {
      this.port.postMessage(command);
      return true;
    } catch {
      this.disconnect();
      return false;
    }
  }

  async reloadTab(): Promise<void> {
    if (this.tabId !== null) await chrome.tabs.reload(this.tabId);
  }

  /** Opens a URL in the followed tab if it is a YouTube tab, otherwise in a new tab. */
  async open(url: string): Promise<void> {
    const c = this.connection;
    if (this.tabId !== null && (c.kind === 'connected' || c.kind === 'needs-reload')) {
      await chrome.tabs.update(this.tabId, { url });
    } else {
      const tab = await chrome.tabs.create({ url, windowId: this.windowId ?? undefined });
      if (this.options.fixedTabId === undefined && tab.id !== undefined) await this.target(tab.id);
    }
  }

  private async target(tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId);
      this.connect(tab);
    } catch {
      this.set({ kind: 'no-tab' });
    }
  }

  private connect(tab: chrome.tabs.Tab): void {
    if (this.disposed || tab.id === undefined) return;
    this.disconnect();
    this.tabId = tab.id;
    if (!isYouTube(tab.url)) {
      this.set({ kind: 'not-youtube', tabId: tab.id });
      return;
    }
    // The tab may still be loading; the content script is not there yet. onUpdated
    // ('complete') will connect again.
    if (tab.status === 'loading') {
      this.set({ kind: 'connecting' });
      return;
    }
    const tabId = tab.id;
    let received = false;
    const port = chrome.tabs.connect(tabId, { name: PLAYER_PORT });
    this.port = port;
    this.set({ kind: 'connecting' });
    port.onMessage.addListener((message: PlayerEvent) => {
      if (!received) {
        received = true;
        this.set({ kind: 'connected', tabId });
      }
      this.options.onEvent(message);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read it so Chrome does not log "Unchecked runtime.lastError"
      if (this.port !== port) return;
      this.port = null;
      if (received) {
        // Content script went away (page reload, bfcache). Try once more; a reload completes
        // via onUpdated, a dead script ends in needs-reload.
        void chrome.tabs.get(tabId).then((t) => (t.status === 'loading' ? this.set({ kind: 'connecting' }) : this.connectOnce(t)), () => this.set({ kind: 'no-tab' }));
      } else {
        this.set({ kind: 'needs-reload', tabId });
      }
    });
  }

  private connectOnce(tab: chrome.tabs.Tab): void {
    if (this.tabId === tab.id) this.connect(tab);
  }

  private disconnect(): void {
    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      // already gone
    }
  }

  private set(connection: Connection): void {
    this.connection = connection;
    this.options.onConnection(connection);
  }
}
