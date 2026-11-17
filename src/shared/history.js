/**
 * Local submission history.
 *
 * Only a SHA-256 fingerprint of the submitted URL is stored, plus a sanitised
 * display name/URL that never includes query strings. This keeps tokens that
 * may appear in `.torrent` URLs out of the history list.
 */

import { canonicalKeyForUrl, describeUrl, sanitizeText } from './urls.js';

export function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintForUrl(url, kind) {
  const canonical = canonicalKeyForUrl(url, kind);
  if (!canonical) return null;
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
}

/**
 * @param {{url: string, kind: 'magnet'|'torrent', pageHostname?: string, now?: number}} input
 */
export async function createHistoryEntry(input) {
  const fingerprint = await fingerprintForUrl(input.url, input.kind);
  if (!fingerprint) return null;

  const description = describeUrl(input.url, input.kind);
  return {
    id: `${Date.now().toString(36)}-${fingerprint.slice(0, 10)}`,
    fingerprint,
    kind: input.kind,
    name: description.name,
    displayUrl: description.url,
    pageHostname: sanitizeText(input.pageHostname, 253) || '',
    addedAt: input.now ?? Date.now(),
  };
}

/** Prepend an entry, replacing an older identical fingerprint, and cap the list. */
export function mergeHistory(entries, entry, maxEntries = 500) {
  if (!entry) return entries;
  const withoutDuplicate = entries.filter((item) => item.fingerprint !== entry.fingerprint);
  return [entry, ...withoutDuplicate].slice(0, maxEntries);
}

/** Return a Set of fingerprints already present for the supplied URLs. */
export async function findKnownUrls(history, urls) {
  const fingerprints = new Set(
    (Array.isArray(history) ? history : []).map((entry) => entry?.fingerprint).filter(Boolean),
  );
  const result = [];
  for (const item of urls) {
    const fingerprint = await fingerprintForUrl(item.url, item.kind);
    result.push(Boolean(fingerprint && fingerprints.has(fingerprint)));
  }
  return result;
}

export function sortHistoryNewestFirst(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort(
    (left, right) => Number(right?.addedAt || 0) - Number(left?.addedAt || 0),
  );
}
