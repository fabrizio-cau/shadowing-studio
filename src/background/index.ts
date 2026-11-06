import { PANEL_PORT, type PanelMessage } from '../shared/messages';

/**
 * Service worker. Deliberately stateless (MV3 workers are suspended and restarted at will):
 * - the toolbar button opens the side panel;
 * - a "REC" badge is shown while a side panel reports it is recording. The badge is tied to the
 *   panel's port, so it is cleared when the panel closes or crashes. If the worker restarts,
 *   the panel reconnects and re-sends its flag.
 */

function configurePanel(): void {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => {
    console.error('Shadowing Studio: could not configure the side panel', err);
  });
}

chrome.runtime.onInstalled.addListener(configurePanel);
chrome.runtime.onStartup.addListener(configurePanel);

const recordingPorts = new Set<chrome.runtime.Port>();

function updateBadge(): void {
  const active = recordingPorts.size > 0;
  void chrome.action.setBadgeText({ text: active ? 'REC' : '' });
  if (active) void chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  void chrome.action.setTitle({ title: active ? 'Shadowing Studio — recording' : 'Open Shadowing Studio' });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  port.onMessage.addListener((message: PanelMessage) => {
    if (message?.type !== 'recording') return;
    if (message.active) recordingPorts.add(port);
    else recordingPorts.delete(port);
    updateBadge();
  });
  port.onDisconnect.addListener(() => {
    recordingPorts.delete(port);
    updateBadge();
  });
});
