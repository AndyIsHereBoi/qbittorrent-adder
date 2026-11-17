import { describe, expect, it, vi } from 'vitest';
import { QBClient } from '../src/background/qbittorrent.js';

const MAGNET = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Test&tr=${encodeURIComponent('https://tracker.example/announce')}`;

function jsonResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain' } });
}

function makeClient(fetchImpl, overrides = {}) {
  return new QBClient({
    baseUrl: 'http://qbt.example:8080',
    username: 'admin',
    password: 'supersecret',
    timeoutMs: 1000,
    fetchImpl,
    ...overrides,
  });
}

describe('qBittorrent session handling', () => {
  it('validates the session and submits without logging in when it is valid', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/v2/app/version')) return jsonResponse('v5.3.0');
      if (url.endsWith('/api/v2/torrents/add')) return jsonResponse('Ok.');
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await makeClient(fetchImpl).addTorrent(MAGNET);
    expect(result.ok).toBe(true);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/v2/app/version',
      '/api/v2/torrents/add',
    ]);
    const addBody = new URLSearchParams(calls[1].options.body);
    expect(addBody.get('urls')).toBe(MAGNET);
    expect(calls[1].options.credentials).toBe('include');
  });

  it('logs in when the session is missing, then validates it and adds', async () => {
    let versionCalls = 0;
    const paths = [];
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === '/api/v2/app/version') {
        versionCalls += 1;
        return versionCalls === 1 ? jsonResponse('Forbidden', 403) : jsonResponse('v5.3.0');
      }
      if (path === '/api/v2/auth/login') return jsonResponse('Ok.');
      if (path === '/api/v2/torrents/add') return jsonResponse('Ok.');
      return jsonResponse('Not found', 404);
    });

    await expect(makeClient(fetchImpl).addTorrent(MAGNET)).resolves.toEqual({ ok: true });
    expect(paths).toEqual([
      '/api/v2/app/version',
      '/api/v2/auth/login',
      '/api/v2/app/version',
      '/api/v2/torrents/add',
    ]);
  });

  it('notifies the caller after a successful login so it can capture the cookie', async () => {
    let versionCalls = 0;
    const onLogin = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/v2/app/version') {
        versionCalls += 1;
        return versionCalls === 1 ? jsonResponse('Forbidden', 403) : jsonResponse('v5.3.0');
      }
      if (path === '/api/v2/auth/login') return jsonResponse('Ok.');
      if (path === '/api/v2/torrents/add') return jsonResponse('Ok.');
      return jsonResponse('Not found', 404);
    });

    await makeClient(fetchImpl, { onLogin }).addTorrent(MAGNET);
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it('retries once after an add request loses its session', async () => {
    let addCalls = 0;
    const paths = [];
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === '/api/v2/app/version') return jsonResponse('v5.3.0');
      if (path === '/api/v2/auth/login') return jsonResponse('Ok.');
      if (path === '/api/v2/torrents/add') {
        addCalls += 1;
        return addCalls === 1 ? jsonResponse('Unauthorized', 401) : jsonResponse('Ok.');
      }
      return jsonResponse('Not found', 404);
    });

    await expect(makeClient(fetchImpl).addTorrent(MAGNET)).resolves.toEqual({ ok: true });
    expect(paths.filter((path) => path.endsWith('/auth/login'))).toHaveLength(1);
    expect(paths.filter((path) => path.endsWith('/torrents/add'))).toHaveLength(2);
  });

  it('reports a login failure with a CSRF hint', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/v2/app/version') return jsonResponse('Forbidden', 403);
      if (path === '/api/v2/auth/login') return jsonResponse('Unauthorized', 401);
      return jsonResponse('Ok.');
    });

    await expect(makeClient(fetchImpl).addTorrent(MAGNET)).rejects.toMatchObject({
      code: 'authentication-failed',
      status: 401,
    });
    await expect(makeClient(fetchImpl).addTorrent(MAGNET)).rejects.toThrow(/CSRF/);
  });

  it('detects a login that is accepted but not retained as a session', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/v2/app/version') return jsonResponse('Forbidden', 403);
      if (path === '/api/v2/auth/login') return jsonResponse('Ok.');
      return jsonResponse('Ok.');
    });

    await expect(makeClient(fetchImpl).addTorrent(MAGNET)).rejects.toMatchObject({
      code: 'session-not-retained',
    });
  });
});

describe('qBittorrent submit errors', () => {
  it('rejects a 200 response with a Fails body', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/v2/app/version') return jsonResponse('v5.3.0');
      return jsonResponse('Fails.');
    });
    await expect(makeClient(fetchImpl).addTorrent(MAGNET)).rejects.toMatchObject({
      code: 'add-rejected',
    });
  });

  it('maps HTTP errors', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/v2/app/version') return jsonResponse('v5.3.0');
      return jsonResponse('Unsupported Media Type', 415);
    });
    await expect(makeClient(fetchImpl).addTorrent(MAGNET)).rejects.toMatchObject({
      code: 'unsupported-media',
      status: 415,
    });
  });

  it('maps a duplicate torrent 409 response', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/v2/app/version') return jsonResponse('v5.3.0');
      return jsonResponse('Conflict', 409);
    });
    await expect(makeClient(fetchImpl).addTorrent(MAGNET)).rejects.toMatchObject({
      code: 'already-exists',
      status: 409,
    });
  });

  it('maps a 404 base URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('Not found', 404));
    await expect(makeClient(fetchImpl).addTorrent(MAGNET)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('maps network failures without leaking the password', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connection refused');
    });
    await expect(makeClient(fetchImpl, { logger }).addTorrent(MAGNET)).rejects.toMatchObject({
      code: 'network',
    });
    const logged = JSON.stringify([
      ...logger.debug.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(logged).not.toContain('supersecret');
    expect(logged).not.toContain('tracker.example');
  });

  it('maps timeouts', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });
    await expect(makeClient(fetchImpl, { timeoutMs: 10 }).addTorrent(MAGNET)).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('rejects invalid schemes before making a request', async () => {
    const fetchImpl = vi.fn();
    await expect(
      makeClient(fetchImpl).addTorrent('ftp://example.org/file.torrent'),
    ).rejects.toMatchObject({ code: 'invalid-url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('connection testing', () => {
  it('tests the connection and returns version details', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/v2/app/version') return jsonResponse('v5.3.0');
      if (path === '/api/v2/app/webapiVersion') return jsonResponse('2.16.2');
      if (path === '/api/v2/app/setPreferences') return jsonResponse('');
      if (path === '/api/v2/auth/login') return jsonResponse('Ok.');
      return jsonResponse('Not found', 404);
    });

    const result = await makeClient(fetchImpl).testConnection();
    expect(result).toMatchObject({
      ok: true,
      version: 'v5.3.0',
      webApiVersion: '2.16.2',
    });
  });

  it('reports a rejected write request separately from the version check', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/v2/app/version') return jsonResponse('v5.3.0');
      if (path === '/api/v2/app/webapiVersion') return jsonResponse('2.16.2');
      if (path === '/api/v2/app/setPreferences') return jsonResponse('Unauthorized', 401);
      return jsonResponse('Not found', 404);
    });

    await expect(makeClient(fetchImpl).testConnection()).rejects.toMatchObject({
      code: 'write-test-failed',
      status: 401,
    });
  });

  it('requires a base URL', () => {
    expect(() => new QBClient({ baseUrl: '' })).toThrow(/not configured/i);
    expect(() => new QBClient({ baseUrl: 'ftp://example.org' })).toThrow(/http/i);
  });
});
