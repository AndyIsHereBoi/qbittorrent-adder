import { describe, expect, it } from 'vitest';
import {
  createHistoryEntry,
  findKnownUrls,
  fingerprintForUrl,
  mergeHistory,
} from '../src/shared/history.js';

const BTIH = '0123456789abcdef0123456789abcdef01234567';

describe('history fingerprints', () => {
  it('produces the same fingerprint for the same torrent with different trackers', async () => {
    const one = `magnet:?xt=urn:btih:${BTIH}&dn=One&tr=https%3A%2F%2Fa.example`;
    const two = `magnet:?xt=urn:btih:${BTIH}&dn=Two&tr=https%3A%2F%2Fb.example`;
    const [left, right] = await Promise.all([
      fingerprintForUrl(one, 'magnet'),
      fingerprintForUrl(two, 'magnet'),
    ]);
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not store query strings in the history display', async () => {
    const entry = await createHistoryEntry({
      url: 'https://example.org/files/movie.torrent?token=private#fragment',
      kind: 'torrent',
      pageHostname: 'index.example',
      now: 1_700_000_000_000,
    });
    expect(entry).not.toBeNull();
    expect(entry.name).toBe('movie.torrent');
    expect(entry.displayUrl).toBe('https://example.org/files/movie.torrent');
    expect(entry.displayUrl).not.toContain('token');
    expect(entry.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.pageHostname).toBe('index.example');
  });

  it('rejects invalid input', async () => {
    expect(await createHistoryEntry({ url: 'not-a-link', kind: 'torrent' })).toBeNull();
  });
});

describe('history list operations', () => {
  it('moves a repeated fingerprint to the front and caps entries', () => {
    const entries = [
      { fingerprint: 'a', addedAt: 3 },
      { fingerprint: 'b', addedAt: 2 },
    ];
    const merged = mergeHistory(entries, { fingerprint: 'b', addedAt: 4 }, 2);
    expect(merged.map((entry) => entry.fingerprint)).toEqual(['b', 'a']);

    const capped = mergeHistory(entries, { fingerprint: 'c', addedAt: 5 }, 2);
    expect(capped.map((entry) => entry.fingerprint)).toEqual(['c', 'a']);
  });

  it('finds previously submitted URLs', async () => {
    const history = [{ fingerprint: await fingerprintForUrl(`magnet:?xt=urn:btih:${BTIH}`, 'magnet') }];
    const result = await findKnownUrls(history, [
      { url: `magnet:?xt=urn:btih:${BTIH}&dn=X`, kind: 'magnet' },
      { url: 'https://example.org/other.torrent', kind: 'torrent' },
    ]);
    expect(result).toEqual([true, false]);
  });
});
