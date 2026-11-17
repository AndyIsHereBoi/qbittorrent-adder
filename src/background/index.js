/**
 * Privileged background context.
 *
 * Owns settings, credentials, history, all qBittorrent network communication,
 * and the CSRF header compatibility layer. Content scripts only ever receive a
 * credential-free public settings object and submit one link at a time.
 */

import { createHistoryEntry, findKnownUrls, mergeHistory } from '../shared/history.js';
import { createLogger, noopLogger } from '../shared/logger.js';
import { MSG } from '../shared/messages.js';
import {
  normalizeBaseUrl,
  publicSettings,
  validateCredentials,
  validateSettings,
} from '../shared/settings-schema.js';
import {
  clearHistory,
  loadConfig,
  loadHistory,
  loadSettings,
  saveConfig,
  saveHistory,
} from '../shared/settings-store.js';
import { classifyUrl } from '../shared/urls.js';
import {
  acquireHeaderRewrite,
  setSessionCookie,
} from './header-rewrite.js';
import { QBClient, QBError } from './qbittorrent.js';

function isExtensionPage(sender) {
  if (!sender || sender.id !== browser.runtime.id) return false;
  const base = browser.runtime.getURL('');
  return [sender.url, sender.tab?.url]
    .filter((url) => typeof url === 'string')
    .some((url) => url.startsWith(base));
}

function isExtensionContext(sender) {
  return Boolean(sender && sender.id === browser.runtime.id);
}

function pageHostname(sender) {
  const url = sender?.tab?.url || sender?.url;
  if (typeof url !== 'string') return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function fail(message, code = 'error') {
  return { ok: false, code, message };
}

function describeError(error, logger = noopLogger) {
  if (error instanceof QBError) {
    logger.warn('qBittorrent operation failed', { code: error.code, status: error.status });
    return fail(error.message, error.code);
  }
  logger.error('Unexpected error in background operation', {
    name: error?.name || 'Error',
  });
  return fail('An unexpected error occurred. Enable debug logging and try again.', 'unexpected');
}

async function getLogger() {
  try {
    const settings = await loadSettings();
    return createLogger(settings.debug, 'qbt');
  } catch {
    return noopLogger;
  }
}

async function broadcast(type) {
  let tabs = [];
  try {
    tabs = await browser.tabs.query({});
  } catch {
    return;
  }
  await Promise.allSettled(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => browser.tabs.sendMessage(tab.id, { type })),
  );
}

function clientFor(settings, credentials, logger, onLogin) {
  return new QBClient({
    baseUrl: settings.connection.baseUrl,
    username: credentials.username,
    password: credentials.password,
    logger,
    onLogin,
  });
}

/**
 * Read qBittorrent's HttpOnly session cookie and make it available to the
 * background request header layer. This avoids relying on SameSite cookie
 * behavior for cross-site extension fetches.
 */
async function syncSessionCookie(baseUrl) {
  if (!baseUrl || !browser.cookies?.getAll) return;
  try {
    const cookies = await browser.cookies.getAll({ url: baseUrl });
    const session = cookies.filter(
      (cookie) => cookie?.name === 'SID' || String(cookie?.name || '').startsWith('QBT_SID_'),
    );
    setSessionCookie(
      baseUrl,
      session.length > 0 ? session.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') : '',
    );
  } catch {
    // Cookie access can fail when host permission is missing; the fetch itself
    // will report the actionable error.
  }
}

async function assertUsableConnection(settings) {
  if (!settings.connection.baseUrl) {
    return fail('qBittorrent is not configured. Open the extension settings.', 'not-configured');
  }
  return null;
}

async function addTorrent(message, sender) {
  const logger = await getLogger();
  const { settings, credentials } = await loadConfig();

  if (!settings.enabled) return fail('The extension is disabled.', 'disabled');

  const rawUrl = typeof message?.url === 'string' ? message.url : '';
  if (!rawUrl || rawUrl.length > 8192) return fail('Invalid link.', 'invalid-url');

  const classified = classifyUrl(rawUrl);
  if (!classified.ok) {
    return fail('Only magnet URIs and http(s) .torrent links can be submitted.', 'invalid-url');
  }
  if (message?.kind && message.kind !== classified.kind) {
    return fail('The link type did not match its contents.', 'invalid-url');
  }

  const unusable = await assertUsableConnection(settings);
  if (unusable) return unusable;

  if (settings.history.enabled && settings.history.duplicateMode === 'disable') {
    const history = await loadHistory();
    const [known] = await findKnownUrls(history, [{ url: classified.url, kind: classified.kind }]);
    if (known) {
      return fail('This item is already in your submission history.', 'duplicate');
    }
  }

  await syncSessionCookie(settings.connection.baseUrl);
  const client = clientFor(settings, credentials, logger, () =>
    syncSessionCookie(settings.connection.baseUrl),
  );
  const release = acquireHeaderRewrite(settings.connection.baseUrl, logger);
  try {
    await client.addTorrent(classified.url);
  } catch (error) {
    if (error instanceof QBError && error.code === 'already-exists') {
      return {
        ok: true,
        duplicate: true,
        message: 'This torrent is already in qBittorrent.',
      };
    }
    return describeError(error, logger);
  } finally {
    release();
  }

  logger.info('Submitted a torrent URL', { kind: classified.kind });

  if (settings.history.enabled) {
    try {
      const entry = await createHistoryEntry({
        url: classified.url,
        kind: classified.kind,
        pageHostname: pageHostname(sender),
      });
      if (entry) {
        const history = await loadHistory();
        const next = mergeHistory(history, entry, settings.history.maxEntries);
        await saveHistory(next);
        await broadcast(MSG.HISTORY_CHANGED);
      }
    } catch {
      logger.warn('Could not save submission to local history');
    }
  }

  return {
    ok: true,
    message: classified.kind === 'magnet' ? 'Magnet added to qBittorrent.' : 'Torrent added to qBittorrent.',
  };
}

async function checkHistory(message) {
  const { settings } = await loadConfig();
  const urls = Array.isArray(message?.urls) ? message.urls.slice(0, 250) : [];
  const normalised = [];

  for (const item of urls) {
    const rawUrl = typeof item?.url === 'string' ? item.url : '';
    const classified = rawUrl ? classifyUrl(rawUrl) : { ok: false };
    if (!classified.ok) {
      normalised.push(null);
      continue;
    }
    normalised.push({ url: classified.url, kind: classified.kind });
  }

  if (!settings.history.enabled) {
    return { ok: true, duplicates: normalised.map(() => false) };
  }

  const history = await loadHistory();
  const duplicates = await findKnownUrls(
    history,
    normalised.map((item) => item || { url: '', kind: 'torrent' }),
  );
  return {
    ok: true,
    duplicates: duplicates.map((value, index) => (normalised[index] ? value : false)),
  };
}

async function getConfig() {
  const { settings, credentials } = await loadConfig();
  return {
    ok: true,
    settings,
    credentials,
  };
}

async function saveConfigMessage(message) {
  const settingsResult = validateSettings(message?.settings || {});
  const credentialsResult = validateCredentials(message?.credentials || {});
  const errors = [...settingsResult.errors, ...credentialsResult.errors];
  if (errors.length > 0) return { ok: false, errors };

  const result = await saveConfig(settingsResult.settings, credentialsResult.credentials);
  if (!result.ok) return { ok: false, errors: result.errors };

  await broadcast(MSG.SETTINGS_CHANGED);
  return { ok: true, settings: result.settings };
}

async function testConnection(message) {
  const logger = createLogger(message?.settings?.debug === true, 'qbt-test');
  const settingsResult = validateSettings(message?.settings || {});
  const credentialsResult = validateCredentials(message?.credentials || {});
  const errors = [...settingsResult.errors, ...credentialsResult.errors];
  if (errors.length > 0) return { ok: false, errors, message: errors[0] };

  const settings = settingsResult.settings;
  if (!settings.connection.baseUrl) {
    return fail('Enter a qBittorrent base URL first.', 'not-configured');
  }

  await syncSessionCookie(settings.connection.baseUrl);
  const client = clientFor(settings, credentialsResult.credentials, logger, () =>
    syncSessionCookie(settings.connection.baseUrl),
  );
  const release = acquireHeaderRewrite(settings.connection.baseUrl, logger);
  try {
    const result = await client.testConnection();
    return {
      ok: true,
      message: result.message,
      version: result.version,
      webApiVersion: result.webApiVersion,
    };
  } catch (error) {
    return describeError(error, logger);
  } finally {
    release();
  }
}

async function getStatus() {
  const { settings, credentials } = await loadConfig();
  const history = settings.history.enabled ? await loadHistory() : [];
  const configured = Boolean(settings.connection.baseUrl);
  let host = '';
  if (configured) {
    try {
      host = new URL(settings.connection.baseUrl).host;
    } catch {
      host = '';
    }
  }

  return {
    ok: true,
    enabled: settings.enabled,
    configured,
    host,
    authMethod: credentials.username ? 'password' : 'none',
    historyCount: history.length,
    debug: settings.debug,
  };
}

async function setEnabled(message) {
  const { settings, credentials } = await loadConfig();
  const next = { ...settings, enabled: message?.enabled !== false };
  const result = await saveConfig(next, credentials);
  if (!result.ok) return { ok: false, errors: result.errors };
  await broadcast(MSG.SETTINGS_CHANGED);
  return { ok: true, enabled: result.settings.enabled };
}

async function handleMessage(message, sender) {
  const type = message?.type;
  if (!type || typeof type !== 'string') return fail('Unknown message.', 'bad-message');
  if (!isExtensionContext(sender)) return fail('Untrusted message sender.', 'forbidden');

  switch (type) {
    case MSG.GET_PUBLIC_SETTINGS: {
      const settings = await loadSettings();
      return { ok: true, settings: publicSettings(settings) };
    }

    case MSG.ADD_TORRENT:
      return addTorrent(message, sender);

    case MSG.CHECK_HISTORY:
      return checkHistory(message);

    case MSG.GET_CONFIG:
    case MSG.SAVE_CONFIG:
    case MSG.TEST_CONNECTION:
    case MSG.GET_HISTORY:
    case MSG.CLEAR_HISTORY:
    case MSG.GET_STATUS:
    case MSG.SET_ENABLED:
      if (!isExtensionPage(sender)) return fail('This action is only available in extension pages.', 'forbidden');
      break;

    default:
      return fail('Unknown message.', 'bad-message');
  }

  switch (type) {
    case MSG.GET_CONFIG:
      return getConfig();

    case MSG.SAVE_CONFIG:
      return saveConfigMessage(message);

    case MSG.TEST_CONNECTION:
      return testConnection(message);

    case MSG.GET_HISTORY: {
      return { ok: true, entries: await loadHistory() };
    }

    case MSG.CLEAR_HISTORY: {
      await clearHistory();
      await broadcast(MSG.HISTORY_CHANGED);
      return { ok: true };
    }

    case MSG.GET_STATUS:
      return getStatus();

    case MSG.SET_ENABLED:
      return setEnabled(message);

    default:
      return fail('Unknown message.', 'bad-message');
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  return handleMessage(message, sender).catch(async (error) => {
    const logger = await getLogger();
    return describeError(error, logger);
  });
});

// Ensure defaults are normalised on first install without overwriting values.
browser.runtime.onInstalled.addListener(async () => {
  const { settings, credentials } = await loadConfig();
  const result = await saveConfig(settings, credentials);
  if (!result.ok) {
    // Storage corruption is recoverable by opening options; do not log values.
    console.warn('[qbt] Stored settings could not be normalised.');
  }
});
