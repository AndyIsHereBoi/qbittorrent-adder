/**
 * Content-script entry point.
 *
 * All credential-bearing work happens in the background. This script only
 * receives credential-free public settings, scans the page, and renders
 * buttons in isolated shadow roots.
 */

import { createLogger, noopLogger } from '../shared/logger.js';
import { MSG } from '../shared/messages.js';
import { createScanner } from './scanner.js';

let settings = null;
let scanner = null;
let logger = noopLogger;

async function request(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch {
    return { ok: false, message: 'The extension background is not available.' };
  }
}

async function loadPublicSettings() {
  const response = await request({ type: MSG.GET_PUBLIC_SETTINGS });
  if (!response?.ok) throw new Error(response?.message || 'Could not load extension settings.');
  return response.settings;
}

async function submit(url, kind) {
  const response = await request({ type: MSG.ADD_TORRENT, url, kind });
  if (!response?.ok) {
    return { ok: false, message: response?.message || 'Could not add this link to qBittorrent.' };
  }
  return { ok: true, message: response.message };
}

async function checkHistory(items) {
  const response = await request({ type: MSG.CHECK_HISTORY, urls: items });
  if (!response?.ok || !Array.isArray(response.duplicates)) return items.map(() => false);
  return response.duplicates;
}

function createCurrentScanner() {
  return createScanner({
    document,
    settings,
    submit,
    checkHistory,
    logger,
  });
}

function applySettings(next) {
  settings = next;
  logger = createLogger(settings.debug === true, 'qbt-page');

  if (scanner) {
    scanner.stop();
    scanner = null;
  }
  if (!settings.enabled) return;

  scanner = createCurrentScanner();
  scanner.start();
}

async function refreshFromStorage() {
  try {
    const next = await loadPublicSettings();
    applySettings(next);
  } catch (error) {
    logger.warn('Could not refresh extension settings');
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.SETTINGS_CHANGED) {
    void refreshFromStorage();
  } else if (message?.type === MSG.HISTORY_CHANGED) {
    void scanner?.refreshHistory();
  }
  return undefined;
});

(async function init() {
  try {
    const next = await loadPublicSettings();
    applySettings(next);
  } catch {
    // The background may not be ready immediately after an update/reload.
    setTimeout(() => void refreshFromStorage(), 400);
  }
})();
