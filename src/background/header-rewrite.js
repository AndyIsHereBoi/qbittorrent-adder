/**
 * qBittorrent CSRF compatibility.
 *
 * qBittorrent's Web UI rejects POST requests whose Origin/Referer do not match
 * its own address. A browser extension necessarily has a `moz-extension://`
 * origin, so the extension rewrites only its own background API requests to
 * the configured qBittorrent origin. Authentication is still enforced by
 * qBittorrent; no auth checks are bypassed.
 *
 * The listener is scoped to:
 *   - the configured/tested qBittorrent API prefix
 *   - background requests (tabId === -1)
 * It never touches normal browsing requests made by tabs.
 */

import { normalizeBaseUrl } from '../shared/settings-schema.js';
import { noopLogger } from '../shared/logger.js';

const targets = new Map();
const sessionCookies = new Map();
let registeredPatternsKey = '';
let listenerAttached = false;

/**
 * qBittorrent's session cookie is SameSite=Lax. A fetch from the extension
 * background is cross-site, so Firefox may refuse to attach it. The background
 * reads the HttpOnly cookie through browser.cookies and this map lets the
 * webRequest listener attach it explicitly for its own API requests.
 */
export function setSessionCookie(baseUrl, cookieHeader) {
  const normalised = normalizeBaseUrl(baseUrl);
  if (!normalised.ok || !normalised.value) return;
  if (cookieHeader) sessionCookies.set(normalised.value, cookieHeader);
  else sessionCookies.delete(normalised.value);
}

function headersFor(details) {
  for (const target of targets.values()) {
    if (!details.url.startsWith(target.apiPrefix)) continue;

    const requestHeaders = (details.requestHeaders || []).filter((header) => {
      const name = String(header.name || '').toLowerCase();
      return name !== 'origin' && name !== 'referer' && name !== 'sec-fetch-site' && name !== 'cookie';
    });

    const cookie = sessionCookies.get(target.key);
    if (cookie) requestHeaders.push({ name: 'Cookie', value: cookie });

    requestHeaders.push(
      { name: 'Origin', value: target.origin },
      { name: 'Referer', value: target.referer },
      { name: 'Sec-Fetch-Site', value: 'same-origin' },
    );
    return { requestHeaders };
  }
  return {};
}

function listener(details) {
  const extensionOrigin =
    typeof details.originUrl === 'string' && details.originUrl.startsWith('moz-extension://');
  if (details.tabId !== -1 && !extensionOrigin) return {};
  return headersFor(details);
}

function syncListener() {
  const origins = [...new Set([...targets.values()].map((target) => target.pattern))];
  const key = origins.slice().sort().join('|');
  if (key === registeredPatternsKey) return;

  if (listenerAttached) {
    browser.webRequest.onBeforeSendHeaders.removeListener(listener);
    listenerAttached = false;
  }

  registeredPatternsKey = key;
  if (origins.length === 0) return;

  browser.webRequest.onBeforeSendHeaders.addListener(
    listener,
    { urls: origins },
    ['blocking', 'requestHeaders'],
  );
  listenerAttached = true;
}

function makeTarget(baseUrl) {
  const normalised = normalizeBaseUrl(baseUrl);
  if (!normalised.ok || !normalised.value) return null;
  const parsed = new URL(normalised.value);

  return {
    key: normalised.value,
    // Firefox match patterns do not support explicit ports. A host-only pattern
    // matches every port; the listener still checks the full URL prefix below.
    pattern: `${parsed.protocol}//${parsed.hostname}/*`,
    origin: parsed.origin,
    referer: `${normalised.value}/`,
    apiPrefix: `${normalised.value}/api/v2/`,
  };
}

/**
 * Register a target while a background API request is in flight.
 * Returns a release function. Reference counting makes overlapping test/add
 * requests safe.
 */
export function acquireHeaderRewrite(baseUrl, logger = noopLogger) {
  const target = makeTarget(baseUrl);
  if (!target) return () => {};

  const existing = targets.get(target.key);
  if (existing) {
    existing.count += 1;
  } else {
    targets.set(target.key, { ...target, count: 1 });
  }
  syncListener();
  logger.debug('Enabled qBittorrent CSRF header rewrite for an API request');

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = targets.get(target.key);
    if (!current) return;
    current.count -= 1;
    if (current.count <= 0) targets.delete(target.key);
    syncListener();
  };
}

/** Visible for diagnostics/tests. */
export function activeRewriteCount() {
  return targets.size;
}
