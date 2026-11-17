/**
 * Local storage helpers. Credentials are kept in a separate storage key from
 * the rest of settings and are only read by privileged extension contexts.
 */

import {
  CREDENTIALS_KEY,
  DEFAULT_CREDENTIALS,
  HISTORY_KEY,
  SETTINGS_KEY,
  validateCredentials,
  validateSettings,
} from './settings-schema.js';
import { sortHistoryNewestFirst } from './history.js';

function browserStorage() {
  if (typeof browser === 'undefined' || !browser.storage?.local) {
    throw new Error('browser.storage.local is not available in this context');
  }
  return browser.storage.local;
}

export async function loadSettings() {
  const stored = await browserStorage().get(SETTINGS_KEY);
  const { settings } = validateSettings(stored?.[SETTINGS_KEY] || {});
  return settings;
}

export async function saveSettings(settings) {
  const result = validateSettings(settings);
  if (result.errors.length > 0) return result;
  await browserStorage().set({ [SETTINGS_KEY]: result.settings });
  return result;
}

export async function loadCredentials() {
  const stored = await browserStorage().get(CREDENTIALS_KEY);
  const raw = stored?.[CREDENTIALS_KEY];
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CREDENTIALS };
  return {
    username: typeof raw.username === 'string' ? raw.username : '',
    password: typeof raw.password === 'string' ? raw.password : '',
  };
}

export async function saveCredentials(credentials) {
  const result = validateCredentials(credentials);
  if (result.errors.length > 0) return result;
  await browserStorage().set({ [CREDENTIALS_KEY]: result.credentials });
  return result;
}

export async function loadConfig() {
  const [settings, credentials] = await Promise.all([loadSettings(), loadCredentials()]);
  return { settings, credentials };
}

export async function saveConfig(settings, credentials) {
  const settingsResult = validateSettings(settings);
  const credentialsResult = validateCredentials(credentials);
  const errors = [...settingsResult.errors, ...credentialsResult.errors];
  if (errors.length > 0) {
    return { ok: false, errors, settings: settingsResult.settings, credentials: credentialsResult.credentials };
  }

  await browserStorage().set({
    [SETTINGS_KEY]: settingsResult.settings,
    [CREDENTIALS_KEY]: credentialsResult.credentials,
  });
  return {
    ok: true,
    errors: [],
    settings: settingsResult.settings,
    credentials: credentialsResult.credentials,
  };
}

export async function loadHistory() {
  const stored = await browserStorage().get(HISTORY_KEY);
  const history = stored?.[HISTORY_KEY];
  return Array.isArray(history)
    ? sortHistoryNewestFirst(history.filter((entry) => entry && typeof entry === 'object'))
    : [];
}

export async function saveHistory(entries) {
  await browserStorage().set({ [HISTORY_KEY]: Array.isArray(entries) ? entries : [] });
}

export async function clearHistory() {
  await browserStorage().remove(HISTORY_KEY);
}
