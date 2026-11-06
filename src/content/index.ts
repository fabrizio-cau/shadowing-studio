import { PLAYER_PORT } from '../shared/messages';
import { PlayerBridge } from './bridge';

/**
 * After the extension is reloaded or updated, the previous content script keeps running in
 * open tabs but is disconnected from the extension. Tell any such instance to shut down so two
 * loop controllers never fight over the same <video>.
 */
const TAKEOVER_EVENT = 'yss-content-takeover';
document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));

const bridge = new PlayerBridge({ doc: document, win: window });

const onTakeover = () => {
  bridge.destroy();
  document.removeEventListener(TAKEOVER_EVENT, onTakeover);
};
document.addEventListener(TAKEOVER_EVENT, onTakeover);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PLAYER_PORT) bridge.addPort(port);
});
