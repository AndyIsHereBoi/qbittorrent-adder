import { describe, expect, it } from 'vitest';
import {
  canonicalKeyForUrl,
  classifyUrl,
  describeUrl,
  findMagnetUrisInText,
  isValidInfoHashUrn,
  parseMagnetUri,
  parseTorrentUrl,
} from '../src/shared/urls.js';

const BTIH_HEX = '0123456789abcdef0123456789abcdef01234567';
const BTIH_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BTMH_HEX = `1220${'ab'.repeat(32)}`;

describe('magnet parsing', () => {
  it('accepts a btih hex info hash', () => {
    const uri = `magnet:?xt=urn:btih:${BTIH_HEX}`;
    const parsed = parseMagnetUri(uri);
    expect(parsed.ok).toBe(true);
    expect(parsed.uri).toBe(uri);
    expect(parsed.infohash).toBe(`btih:${BTIH_HEX}`);
  });

  it('accepts a btih base32 info hash', () => {
    expect(parseMagnetUri(`magnet:?xt=urn:btih:${BTIH_BASE32}`).ok).toBe(true);
    expect(isValidInfoHashUrn(`urn:btih:${BTIH_BASE32}`)).toBe(true);
  });

  it('accepts btmh hex and base32 info hashes', () => {
    expect(parseMagnetUri(`magnet:?xt=urn:btmh:${BTMH_HEX}`).ok).toBe(true);
    expect(isValidInfoHashUrn(`urn:btmh:${'A'.repeat(55)}`)).toBe(true);
    expect(parseMagnetUri(`magnet:?xt=urn:btmh:${'A'.repeat(55)}`).ok).toBe(true);
  });

  it('preserves the complete magnet URI, including trackers and parameters', () => {
    const uri = `magnet:?xt=urn:btih:${BTIH_HEX}&dn=Example%20File&tr=${encodeURIComponent(
      'https://tracker.example/announce?passkey=secret',
    )}&xl=123&ws=https%3A%2F%2Fcdn.example%2Ffile`;
    const parsed = parseMagnetUri(uri);
    expect(parsed.ok).toBe(true);
    expect(parsed.uri).toBe(uri);
    expect(parsed.displayName).toBe('Example File');
    expect(decodeURIComponent(parsed.uri)).toContain('passkey=secret');
  });

  it('finds one valid xt among several', () => {
    const parsed = parseMagnetUri(`magnet:?xt=urn:btih:not-a-hash&xt=urn:btmh:${BTMH_HEX}`);
    expect(parsed.ok).toBe(true);
    expect(parsed.infohash).toBe(`btmh:${BTMH_HEX}`);
  });

  it('rejects invalid or missing info hashes', () => {
    expect(parseMagnetUri('magnet:?dn=NoHash').ok).toBe(false);
    expect(parseMagnetUri(`magnet:?xt=urn:btih:${BTIH_HEX.slice(0, 39)}`).ok).toBe(false);
    expect(parseMagnetUri('https://example.com/file.torrent').ok).toBe(false);
    expect(parseMagnetUri('').ok).toBe(false);
    expect(parseMagnetUri(null).ok).toBe(false);
  });

  it('finds magnet URIs in text and strips sentence punctuation', () => {
    const uri = `magnet:?xt=urn:btih:${BTIH_HEX}&dn=Text`;
    const text = `Use this: ${uri}. Also (${uri})`;
    const found = findMagnetUrisInText(text);
    expect(found).toHaveLength(1);
    expect(found[0].uri).toBe(uri);
  });
});

describe('.torrent URL detection', () => {
  it('detects a .torrent path case-insensitively and preserves query/fragment', () => {
    const url = 'https://example.org/files/MOVIE.Torrent?token=abc#frag';
    const parsed = parseTorrentUrl(url);
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toBe(url);
  });

  it('does not mistake query strings for the suffix', () => {
    expect(parseTorrentUrl('https://example.org/download?file=movie.torrent').ok).toBe(false);
    expect(parseTorrentUrl('https://example.org/file.torrent.bak').ok).toBe(false);
    expect(parseTorrentUrl('https://example.org/file.torrent/extra').ok).toBe(false);
  });

  it('resolves relative URLs and allows only http(s)', () => {
    expect(parseTorrentUrl('/files/a.torrent?x=1', 'https://example.org/page').url).toBe(
      'https://example.org/files/a.torrent?x=1',
    );
    expect(parseTorrentUrl('ftp://example.org/a.torrent').ok).toBe(false);
    expect(parseTorrentUrl('javascript:alert(1)//a.torrent').ok).toBe(false);
    expect(parseTorrentUrl('https://user:pass@example.org/a.torrent').ok).toBe(false);
  });

  it('classifies links', () => {
    expect(classifyUrl('magnet:?xt=urn:btih:' + BTIH_HEX).kind).toBe('magnet');
    expect(classifyUrl('https://example.org/a.torrent?x=1').kind).toBe('torrent');
    expect(classifyUrl('https://example.org/page').ok).toBe(false);
  });
});

describe('canonical identity and display', () => {
  it('ignores trackers and display names for history duplicate detection', () => {
    const one = `magnet:?xt=urn:btih:${BTIH_HEX}&dn=One&tr=https%3A%2F%2Fa.example`;
    const two = `magnet:?xt=urn:btih:${BTIH_HEX}&dn=Two&tr=https%3A%2F%2Fb.example`;
    expect(canonicalKeyForUrl(one, 'magnet')).toBe(canonicalKeyForUrl(two, 'magnet'));
  });

  it('keeps torrent query strings for identity but strips fragments for display', () => {
    const one = 'https://example.org/a.torrent?token=secret#one';
    const two = 'https://example.org/a.torrent?token=secret#two';
    expect(canonicalKeyForUrl(one, 'torrent')).toBe(canonicalKeyForUrl(two, 'torrent'));
    const described = describeUrl(one, 'torrent');
    expect(described.name).toBe('a.torrent');
    expect(described.url).toBe('https://example.org/a.torrent');
    expect(described.url).not.toContain('secret');
  });

  it('does not expose magnet trackers in the display URL', () => {
    const described = describeUrl(
      `magnet:?xt=urn:btih:${BTIH_HEX}&dn=Nice&tr=https%3A%2F%2Ftracker.example%2Fsecret`,
      'magnet',
    );
    expect(described.name).toBe('Nice');
    expect(described.url).toContain(`urn%3Abtih%3A${BTIH_HEX}`);
    expect(described.url).not.toContain('secret');
  });
});
