/**
 * Pure URL helpers shared by the scanner, background worker, and tests.
 *
 * These functions deliberately do not use the DOM. Page-provided values are
 * treated as untrusted input: anything that is not a well-formed magnet URI or
 * an absolute http(s) `.torrent` URL is rejected.
 */

export const MAX_MAGNET_LENGTH = 8192;
export const MAX_TORRENT_URL_LENGTH = 4096;

const BTIH_HEX = /^urn:btih:[0-9a-f]{40}$/i;
const BTIH_BASE32 = /^urn:btih:[a-z2-7]{32}$/i;
const BTMH_HEX = /^urn:btmh:1220[0-9a-f]{64}$/i;
const BTMH_BASE32 = /^urn:btmh:[a-z2-7]{55}$/i;

/** Return true when an `xt` value is a recognised BitTorrent v1/v2 URN. */
export function isValidInfoHashUrn(value) {
  if (typeof value !== 'string') return false;
  return (
    BTIH_HEX.test(value) ||
    BTIH_BASE32.test(value) ||
    BTMH_HEX.test(value) ||
    BTMH_BASE32.test(value)
  );
}

/**
 * Parse and validate a magnet URI.
 *
 * The complete URI is preserved (including trackers and other parameters).
 * Only `urn:btih:` and `urn:btmh:` info hashes are accepted.
 *
 * @param {unknown} value
 * @returns {{ok: true, uri: string, infohash: string, displayName: string|null}
 *   | {ok: false, reason: string}}
 */
export function parseMagnetUri(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not-a-string' };

  const uri = value.trim();
  if (!uri) return { ok: false, reason: 'empty' };
  if (uri.length > MAX_MAGNET_LENGTH) return { ok: false, reason: 'too-long' };
  if (!/^magnet:\?/i.test(uri)) return { ok: false, reason: 'not-a-magnet-uri' };

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }

  if (parsed.protocol.toLowerCase() !== 'magnet:') {
    return { ok: false, reason: 'not-a-magnet-uri' };
  }

  const xtValues = [];
  let displayName = null;
  for (const [key, value] of parsed.searchParams) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'xt') xtValues.push(value);
    else if (lowerKey === 'dn' && displayName === null) displayName = value;
  }

  const infohashUrn = xtValues.find(isValidInfoHashUrn);
  if (!infohashUrn) return { ok: false, reason: 'missing-valid-infohash' };

  return {
    ok: true,
    uri,
    urn: infohashUrn,
    infohash: infohashUrn.slice(infohashUrn.indexOf(':') + 1).toLowerCase(),
    displayName: sanitizeText(displayName, 160),
  };
}

/**
 * Resolve and validate a `.torrent` file URL.
 *
 * The suffix check is case-insensitive and applies to the URL pathname only,
 * so query strings and fragments are preserved in the returned URL.
 *
 * @param {unknown} value
 * @param {string} [base] Base URL used for relative links.
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
export function parseTorrentUrl(value, base) {
  if (typeof value !== 'string') return { ok: false, reason: 'not-a-string' };

  const raw = value.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (raw.length > MAX_TORRENT_URL_LENGTH) return { ok: false, reason: 'too-long' };

  let parsed;
  try {
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-scheme' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials-in-url' };
  }
  if (!parsed.pathname.toLowerCase().endsWith('.torrent')) {
    return { ok: false, reason: 'not-a-torrent-path' };
  }

  return { ok: true, url: parsed.href };
}

/**
 * Classify a link/attribute/text value.
 *
 * @param {unknown} value
 * @param {string} [base]
 * @returns {{ok: true, kind: 'magnet'|'torrent', url: string, infohash?: string, displayName?: string|null}
 *   | {ok: false, reason: string}}
 */
export function classifyUrl(value, base) {
  const magnet = parseMagnetUri(value);
  if (magnet.ok) {
    return {
      ok: true,
      kind: 'magnet',
      url: magnet.uri,
      infohash: magnet.infohash,
      displayName: magnet.displayName,
    };
  }

  const torrent = parseTorrentUrl(value, base);
  if (torrent.ok) return { ok: true, kind: 'torrent', url: torrent.url };

  return { ok: false, reason: torrent.reason === 'not-a-torrent-path' ? magnet.reason : torrent.reason };
}

/** Find all magnet URIs embedded in plain text, e.g. inside a <code> block. */
export function findMagnetUrisInText(text) {
  if (typeof text !== 'string' || !text) return [];

  const found = [];
  const seen = new Set();
  const candidatePattern = /magnet:\?[^\s"'<>]+/gi;

  for (const match of text.matchAll(candidatePattern)) {
    let candidate = match[0];
    // Strip common sentence punctuation that is unlikely to be part of a URI.
    while (candidate.length > 0 && /[.,;)\]}'"]$/.test(candidate)) {
      candidate = candidate.slice(0, -1);
    }
    const parsed = parseMagnetUri(candidate);
    if (!parsed.ok || seen.has(parsed.uri)) continue;
    seen.add(parsed.uri);
    found.push(parsed);
  }

  return found;
}

/**
 * Build a stable, non-reversible key for duplicate detection.
 * Trackers and display names do not change the identity of a magnet.
 */
export function canonicalKeyForUrl(url, kind) {
  if (kind === 'magnet') {
    const parsed = parseMagnetUri(url);
    return parsed.ok ? `magnet:${parsed.infohash}` : null;
  }

  const parsed = parseTorrentUrl(url);
  if (!parsed.ok) return null;

  const withoutFragment = new URL(parsed.url);
  withoutFragment.hash = '';
  return `torrent:${withoutFragment.href}`;
}

/** Short, human-readable description that never includes query tokens. */
export function describeUrl(url, kind) {
  if (kind === 'magnet') {
    const parsed = parseMagnetUri(url);
    if (!parsed.ok) return { name: 'Magnet link', url: 'magnet:' };
    const name = parsed.displayName || `Magnet ${parsed.infohash.slice(0, 12)}…`;
    return {
      name: sanitizeText(name, 120),
      url: sanitizeText(`magnet:?xt=${encodeURIComponent(parsed.urn)}`, 240),
    };
  }

  const parsed = parseTorrentUrl(url);
  if (!parsed.ok) return { name: 'Torrent URL', url: '' };
  const parsedUrl = new URL(parsed.url);
  let filename = 'Torrent file';
  try {
    const last = parsedUrl.pathname.split('/').filter(Boolean).pop();
    if (last) filename = decodeURIComponent(last);
  } catch {
    // Keep the generic filename when percent-decoding fails.
  }
  return {
    name: sanitizeText(filename, 120),
    url: sanitizeText(`${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`, 280),
  };
}

/** Remove control characters and clamp a display-only string. */
export function sanitizeText(value, maxLength = 200) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
