/**
 * Settings schema, validation, and safe defaults.
 *
 * Everything stored here is sanitised before it is persisted. Options and
 * background both run this validation so a corrupt/edited storage entry cannot
 * inject markup, invalid selectors, or arbitrary CSS.
 */

export const SETTINGS_KEY = 'settings';
export const CREDENTIALS_KEY = 'credentials';
export const HISTORY_KEY = 'history';

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  enabled: true,
  connection: Object.freeze({ baseUrl: '' }),
  search: Object.freeze({
    magnetAnchors: true,
    torrentLinks: true,
    extraAttributes: Object.freeze([]),
    textSelectors: Object.freeze(['code']),
  }),
  display: Object.freeze({
    placement: 'after',
    layout: 'inline',
    scale: 100,
    siteRules: Object.freeze([]),
  }),
  history: Object.freeze({
    enabled: true,
    duplicateMode: 'allow',
    maxEntries: 500,
  }),
  debug: false,
});

export const DEFAULT_CREDENTIALS = Object.freeze({
  username: '',
  password: '',
});

const PLACEMENTS = new Set(['after', 'before']);
const LAYOUTS = new Set(['inline', 'block']);
const DUPLICATE_MODES = new Set(['allow', 'disable']);
const ATTRIBUTE_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
const HOST_RULE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/** True for the hostname patterns accepted by per-site display rules. */
export function isValidHostnameRule(value) {
  const hostname = String(value || '').trim().toLowerCase();
  return Boolean(hostname) && hostname.length <= 253 && HOST_RULE.test(hostname);
}

/**
 * Normalise a user-provided qBittorrent base URL.
 * - adds http:// when the scheme is omitted
 * - allows an optional reverse-proxy path
 * - rejects embedded credentials, queries, and fragments
 *
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function normalizeBaseUrl(input) {
  if (input === undefined || input === null || input === '') {
    return { ok: true, value: '' };
  }
  if (typeof input !== 'string') return { ok: false, error: 'Base URL must be text.' };

  let value = input.trim();
  if (!value) return { ok: true, value: '' };
  if (value.length > 2048) return { ok: false, error: 'Base URL is too long.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'Enter a valid URL, for example http://localhost:8080.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// qBittorrent URLs are supported.' };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: 'Do not put a username or password in the URL. Use the credential fields instead.',
    };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'The qBittorrent base URL must not contain a query string or fragment.' };
  }

  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname === '/') pathname = '';
  return { ok: true, value: `${parsed.origin}${pathname}` };
}

function stringList(value, maxItems, maxLength) {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : [];
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    const clamped = text.slice(0, maxLength);
    const key = clamped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clamped);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeSiteRules(input, errors) {
  if (!Array.isArray(input)) return [];
  const rules = [];
  const seen = new Set();

  for (const raw of input.slice(0, 100)) {
    if (!raw || typeof raw !== 'object') continue;
    const hostname = String(raw.hostname ?? '').trim().toLowerCase();
    if (!hostname || hostname.length > 253 || !HOST_RULE.test(hostname)) {
      errors.push(`Invalid site hostname: "${hostname || '(empty)'}".`);
      continue;
    }
    if (seen.has(hostname)) continue;
    seen.add(hostname);

    rules.push({
      hostname,
      enabled: raw.enabled !== false,
      placement: PLACEMENTS.has(raw.placement) ? raw.placement : 'default',
      layout: LAYOUTS.has(raw.layout) ? raw.layout : 'default',
    });
  }
  return rules;
}

/**
 * Validate and normalise a full or partial settings object.
 * Unknown properties are dropped rather than persisted.
 */
export function validateSettings(input = {}) {
  const errors = [];
  const raw = input && typeof input === 'object' ? input : {};
  const rawConnection = raw.connection && typeof raw.connection === 'object' ? raw.connection : {};
  const rawSearch = raw.search && typeof raw.search === 'object' ? raw.search : {};
  const rawDisplay = raw.display && typeof raw.display === 'object' ? raw.display : {};
  const rawHistory = raw.history && typeof raw.history === 'object' ? raw.history : {};

  const baseUrlResult = normalizeBaseUrl(rawConnection.baseUrl);
  if (!baseUrlResult.ok) errors.push(baseUrlResult.error);

  const extraAttributes = stringList(rawSearch.extraAttributes, 20, 100).filter((attribute) => {
    if (ATTRIBUTE_NAME.test(attribute)) return true;
    errors.push(`Invalid HTML attribute name: "${attribute}".`);
    return false;
  });

  const textSelectors = (rawSearch.textSelectors === undefined
    ? [...DEFAULT_SETTINGS.search.textSelectors]
    : stringList(rawSearch.textSelectors, 20, 200)
  ).filter((selector) => {
    if (/[{}<>;]/.test(selector)) {
      errors.push(`Invalid CSS selector: "${selector}".`);
      return false;
    }
    return true;
  });

  const maxEntriesRaw = Number(rawHistory.maxEntries);
  const maxEntries = Number.isFinite(maxEntriesRaw)
    ? Math.min(2000, Math.max(10, Math.round(maxEntriesRaw)))
    : DEFAULT_SETTINGS.history.maxEntries;

  const scaleRaw = Number(rawDisplay.scale);
  const scale =
    Number.isFinite(scaleRaw) && scaleRaw > 0
      ? Math.min(200, Math.max(50, Math.round(scaleRaw)))
      : 100;

  const settings = {
    version: 1,
    enabled: raw.enabled !== false,
    connection: { baseUrl: baseUrlResult.ok ? baseUrlResult.value : '' },
    search: {
      magnetAnchors: rawSearch.magnetAnchors !== false,
      torrentLinks: rawSearch.torrentLinks !== false,
      extraAttributes,
      textSelectors,
    },
    display: {
      placement: PLACEMENTS.has(rawDisplay.placement) ? rawDisplay.placement : 'after',
      layout: LAYOUTS.has(rawDisplay.layout) ? rawDisplay.layout : 'inline',
      scale,
      siteRules: normalizeSiteRules(rawDisplay.siteRules, errors),
    },
    history: {
      enabled: rawHistory.enabled !== false,
      duplicateMode: DUPLICATE_MODES.has(rawHistory.duplicateMode)
        ? rawHistory.duplicateMode
        : 'allow',
      maxEntries,
    },
    debug: raw.debug === true,
  };

  return { settings, errors };
}

/** Validate credentials before storing them locally. */
export function validateCredentials(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const errors = [];

  const username = typeof raw.username === 'string' ? raw.username : '';
  const password = typeof raw.password === 'string' ? raw.password : '';

  if (username.length > 512) errors.push('Username is too long.');
  if (password.length > 2048) errors.push('Password is too long.');
  if (password && !username) errors.push('A username is required when a password is set.');

  return {
    credentials: {
      username: username.slice(0, 512),
      password: password.slice(0, 2048),
    },
    errors,
  };
}

/** Check that a CSS selector is syntactically usable in the current document. */
export function isUsableSelector(selector, documentRef) {
  try {
    documentRef.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safe subset sent to content scripts. Credentials and the qBittorrent base
 * URL are intentionally excluded.
 */
export function publicSettings(settings) {
  return {
    enabled: settings.enabled,
    search: {
      magnetAnchors: settings.search.magnetAnchors,
      torrentLinks: settings.search.torrentLinks,
      extraAttributes: [...settings.search.extraAttributes],
      textSelectors: [...settings.search.textSelectors],
    },
    display: {
      placement: settings.display.placement,
      layout: settings.display.layout,
      scale: settings.display.scale,
      siteRules: settings.display.siteRules.map((rule) => ({ ...rule })),
    },
    history: {
      enabled: settings.history.enabled,
      duplicateMode: settings.history.duplicateMode,
    },
    debug: settings.debug,
  };
}
