// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScanner, HOST_ATTRIBUTE } from '../src/content/scanner.js';

const BTIH = '0123456789abcdef0123456789abcdef01234567';
const MAGNET = `magnet:?xt=urn:btih:${BTIH}&dn=Example&tr=${encodeURIComponent('https://tracker.example/announce')}`;
const OTHER_MAGNET = `magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=Other`;
const TORRENT = 'https://example.org/files/Movie.Torrent?token=abc#frag';

function makeSettings(overrides = {}) {
  const base = {
    enabled: true,
    search: {
      magnetAnchors: true,
      torrentLinks: true,
      extraAttributes: [],
      textSelectors: [],
    },
    display: {
      placement: 'after',
      layout: 'inline',
      siteRules: [],
    },
    history: {
      enabled: true,
      duplicateMode: 'allow',
    },
    debug: false,
  };
  return {
    ...base,
    ...overrides,
    search: { ...base.search, ...(overrides.search || {}) },
    display: { ...base.display, ...(overrides.display || {}) },
    history: { ...base.history, ...(overrides.history || {}) },
  };
}

function makeScanner(settings, options = {}) {
  return createScanner({
    document,
    settings,
    submit: options.submit || vi.fn().mockResolvedValue({ ok: true, message: 'Added.' }),
    checkHistory: options.checkHistory || vi.fn().mockResolvedValue([]),
    logger: options.logger,
  });
}

const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

let scanner = null;

beforeEach(() => {
  document.body.replaceChildren();
  scanner = null;
});

afterEach(() => {
  scanner?.stop();
  scanner = null;
  vi.restoreAllMocks();
});

describe('link detection and duplicate prevention', () => {
  it('adds one button per link and preserves the original links', () => {
    document.body.innerHTML = `
      <p><a id="magnet" href="${MAGNET}">Magnet</a></p>
      <p><a id="torrent" href="${TORRENT}">Torrent</a></p>
      <p><a id="plain" href="https://example.org/page">Plain</a></p>
    `;

    scanner = makeScanner(makeSettings());
    scanner.start();

    const records = scanner.getRecords();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.items[0].kind).sort()).toEqual(['magnet', 'torrent']);

    const magnetRecord = records.find((record) => record.items[0].kind === 'magnet');
    expect(magnetRecord.items[0].url).toBe(MAGNET);
    expect(document.getElementById('magnet').getAttribute('href')).toBe(MAGNET);

    const torrentRecord = records.find((record) => record.items[0].kind === 'torrent');
    expect(torrentRecord.items[0].url).toBe(TORRENT);
    expect(document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)).toHaveLength(2);
    expect(document.getElementById('plain').nextElementSibling).toBeNull();
  });

  it('does not duplicate buttons when the same page is rescanned', () => {
    document.body.innerHTML = `<a id="magnet" href="${MAGNET}">Magnet</a>`;
    scanner = makeScanner(makeSettings());
    scanner.start();
    scanner.scanAll();
    scanner.scanAll();
    scanner.scanNode(document.getElementById('magnet'));

    expect(scanner.getRecords()).toHaveLength(1);
    expect(scanner.getRecords()[0].items).toHaveLength(1);
    expect(document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it('scans additional attributes and text selectors without duplicate buttons', () => {
    document.body.innerHTML = `
      <div id="attr" data-magnet="${OTHER_MAGNET}"></div>
      <pre><code id="code" data-magnet="${MAGNET}">${MAGNET}</code></pre>
    `;

    scanner = makeScanner(
      makeSettings({
        search: { extraAttributes: ['data-magnet'], textSelectors: ['code'] },
      }),
    );
    scanner.start();

    const records = scanner.getRecords();
    expect(records).toHaveLength(2);
    const codeRecord = records.find((record) => record.target.id === 'code');
    expect(codeRecord.items).toHaveLength(1);
    expect(codeRecord.items[0].url).toBe(MAGNET);
    expect(codeRecord.items[0].key).toBe(`magnet:${MAGNET}`);
  });

  it('respects magnet and .torrent detection toggles', () => {
    document.body.innerHTML = `
      <a id="magnet" href="${MAGNET}">Magnet</a>
      <a id="torrent" href="${TORRENT}">Torrent</a>
    `;
    scanner = makeScanner(makeSettings({ search: { magnetAnchors: false, torrentLinks: true } }));
    scanner.start();
    expect(scanner.getRecords()).toHaveLength(1);
    expect(scanner.getRecords()[0].items[0].kind).toBe('torrent');
  });

  it('detects links added after initial load', async () => {
    scanner = makeScanner(makeSettings());
    scanner.start();
    expect(scanner.getRecords()).toHaveLength(0);

    const link = document.createElement('a');
    link.href = MAGNET;
    link.textContent = 'Later';
    document.body.append(link);

    await flush(350);
    expect(scanner.getRecords()).toHaveLength(1);
    expect(document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it('removes a button when its link is removed', async () => {
    document.body.innerHTML = `<a id="magnet" href="${MAGNET}">Magnet</a>`;
    scanner = makeScanner(makeSettings());
    scanner.start();
    expect(document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)).toHaveLength(1);

    document.getElementById('magnet').remove();
    await flush(250);
    expect(document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)).toHaveLength(0);
    expect(scanner.getRecords()).toHaveLength(0);
  });
});

describe('per-site display and history states', () => {
  it('hides buttons for a matching site rule', () => {
    document.body.innerHTML = `<a href="${MAGNET}">Magnet</a>`;
    scanner = makeScanner(
      makeSettings({
        display: {
          siteRules: [{ hostname: window.location.hostname, enabled: false, placement: 'default', layout: 'default' }],
        },
      }),
    );
    scanner.start();
    expect(scanner.getRecords()).toHaveLength(0);
    expect(document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)).toHaveLength(0);
  });

  it('places the button before the link when configured', () => {
    document.body.innerHTML = `<a id="magnet" href="${MAGNET}">Magnet</a>`;
    scanner = makeScanner(makeSettings({ display: { placement: 'before' } }));
    scanner.start();
    const host = document.querySelector(`[${HOST_ATTRIBUTE}]`);
    expect(document.getElementById('magnet').previousElementSibling).toBe(host);
  });

  it('disables buttons for items already in history when configured', async () => {
    document.body.innerHTML = `<a href="${MAGNET}">Magnet</a>`;
    scanner = makeScanner(
      makeSettings({ history: { duplicateMode: 'disable' } }),
      { checkHistory: vi.fn().mockResolvedValue([true]) },
    );
    scanner.start();
    await scanner.refreshHistory();

    const item = scanner.getRecords()[0].items[0];
    expect(item.state).toBe('duplicate');
    expect(item.button.disabled).toBe(true);
  });
});

describe('button states', () => {
  it('shows sending then success, and never submits automatically', async () => {
    document.body.innerHTML = `<a href="${MAGNET}">Magnet</a>`;
    let resolveSubmit;
    const submit = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    scanner = makeScanner(makeSettings(), { submit });
    scanner.start();

    const item = scanner.getRecords()[0].items[0];
    expect(submit).not.toHaveBeenCalled();
    item.button.click();
    await flush(0);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(MAGNET, 'magnet');
    expect(item.state).toBe('sending');
    expect(item.button.disabled).toBe(true);

    resolveSubmit({ ok: true, message: 'Magnet added to qBittorrent.' });
    await flush(0);
    expect(item.state).toBe('success');
    expect(item.button.disabled).toBe(true);
    expect(item.element.querySelector('.qbt-status').textContent).toBe('Added');
  });

  it('shows a failure and allows a retry', async () => {
    document.body.innerHTML = `<a href="${MAGNET}">Magnet</a>`;
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Cannot reach qBittorrent.'))
      .mockResolvedValueOnce({ ok: true, message: 'Added.' });
    scanner = makeScanner(makeSettings(), { submit });
    scanner.start();

    const item = scanner.getRecords()[0].items[0];
    item.button.click();
    await flush(0);
    expect(item.state).toBe('error');
    expect(item.button.disabled).toBe(false);
    expect(item.element.querySelector('.qbt-status').textContent).toBe('Failed');
    expect(item.button.title).toContain('Cannot reach qBittorrent.');

    item.button.click();
    await flush(0);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(item.state).toBe('success');
  });

  it('does not submit when the extension reports disabled', async () => {
    document.body.innerHTML = `<a href="${MAGNET}">Magnet</a>`;
    const submit = vi.fn().mockResolvedValue({ ok: false, message: 'The extension is disabled.' });
    scanner = makeScanner(makeSettings(), { submit });
    scanner.start();

    const item = scanner.getRecords()[0].items[0];
    item.button.click();
    await flush(0);
    expect(item.state).toBe('error');
    expect(item.button.title).toContain('disabled');
  });
});
