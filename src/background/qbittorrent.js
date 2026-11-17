/**
 * qBittorrent Web API client.
 *
 * Runs only in the privileged background context. The client validates an
 * existing session before submitting, logs in with the Web UI username and
 * password when required, and retries once if the session expires between the
 * validation and add requests.
 *
 * Optional API keys (qBittorrent 5.2+) are supported as an alternative to the
 * cookie session flow. They are sent as a Bearer token and are never exposed
 * to content scripts.
 */

import { classifyUrl } from '../shared/urls.js';
import { normalizeBaseUrl } from '../shared/settings-schema.js';
import { noopLogger } from '../shared/logger.js';

export class QBError extends Error {
  constructor(message, code = 'qbt-error', status = null) {
    super(message);
    this.name = 'QBError';
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class QBClient {
  constructor(options) {
    const normalised = normalizeBaseUrl(options?.baseUrl || '');
    if (!normalised.ok) throw new QBError(normalised.error, 'invalid-base-url');
    if (!normalised.value) throw new QBError('qBittorrent base URL is not configured.', 'not-configured');

    this.baseUrl = normalised.value;
    this.username = typeof options?.username === 'string' ? options.username : '';
    this.password = typeof options?.password === 'string' ? options.password : '';
    this.fetchImpl = options?.fetchImpl || globalThis.fetch.bind(globalThis);
    this.timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.logger = options?.logger || noopLogger;
    this.onLogin = typeof options?.onLogin === 'function' ? options.onLogin : null;
  }

  endpoint(path) {
    return `${this.baseUrl}/api/v2/${path}`;
  }

  async request(path, { method = 'GET', body, headers = {}, fetchOptions = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();

    const requestHeaders = { Accept: '*/*', ...headers };

    try {
      this.logger.debug(`Request ${method} /api/v2/${path}`);
      const response = await this.fetchImpl(this.endpoint(path), {
        method,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        headers: requestHeaders,
        body,
        signal: controller.signal,
        ...fetchOptions,
      });

      const text = await response.text();
      this.logger.debug(`Response ${method} /api/v2/${path}`, {
        status: response.status,
        ms: Date.now() - started,
      });

      return { ok: response.ok, status: response.status, text };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new QBError(
          `The request to qBittorrent timed out after ${Math.round(this.timeoutMs / 1000)} seconds. ` +
            'If qBittorrent is on a local network, Firefox 160+ may be blocking local network ' +
            'access. Add the qBittorrent host/IP to network.lna.skip-domains in about:config, or ' +
            'use a loopback bridge.',
          'timeout',
        );
      }
      if (error instanceof QBError) throw error;
      this.logger.warn('Network request to qBittorrent failed', {
        ms: Date.now() - started,
        name: error?.name || 'Error',
      });
      throw new QBError(
        'Cannot reach qBittorrent. Check the base URL, make sure qBittorrent is running, ' +
          'and confirm that the extension has permission for that address. Firefox 160+ may be ' +
          'blocking local network access; add the qBittorrent host/IP to network.lna.skip-domains ' +
          'in about:config or use a loopback bridge.',
        'network',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  formBody(values) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) params.set(key, value);
    return params.toString();
  }

  async getVersion() {
    return this.request('app/version');
  }

  async getWebApiVersion() {
    return this.request('app/webapiVersion');
  }

  /** Send one login request and translate qBittorrent's textual replies. */
  async login() {
    if (!this.username) {
      throw new QBError(
        'qBittorrent requires a login. Enter a username and password in the extension settings.',
        'missing-credentials',
      );
    }

    const result = await this.request('auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: this.formBody({ username: this.username, password: this.password }),
    });

    if (result.status === 401) {
      throw new QBError(
        'qBittorrent rejected the login (401). Check the username and password. If they are ' +
          'correct, qBittorrent may be blocking the request with CSRF protection; reload the ' +
          'extension and retry.',
        'authentication-failed',
        401,
      );
    }
    if (result.status === 403) {
      throw new QBError(
        'qBittorrent refused the login (403). Your IP may be temporarily banned after too many ' +
          'failed attempts, or the Web UI may be blocking this browser.',
        'login-forbidden',
        403,
      );
    }
    if (!result.ok) {
      throw this.httpError(result, 'login');
    }

    const text = result.text.trim();
    if (/fails?\.?$/i.test(text) || /^fails?$/i.test(text)) {
      throw new QBError('qBittorrent rejected the username or password.', 'authentication-failed', 200);
    }

    this.logger.info('qBittorrent login accepted');
    if (this.onLogin) {
      try {
        await this.onLogin();
      } catch {
        this.logger.warn('Could not read the qBittorrent session cookie after login');
      }
    }
  }

  /** True when the current cookie/token is accepted by the Web API. */
  async sessionIsValid() {
    const result = await this.getVersion();
    if (result.status === 200) return true;
    if (result.status === 401 || result.status === 403) return false;
    throw this.httpError(result, 'session-check');
  }

  async ensureSession() {
    let valid = false;
    try {
      valid = await this.sessionIsValid();
    } catch (error) {
      // A 404 here usually means the base URL or reverse-proxy path is wrong.
      throw error;
    }

    if (!valid) {
      this.logger.debug('No valid qBittorrent session; logging in');
      await this.login();
      const afterLogin = await this.sessionIsValid();
      if (!afterLogin) {
        throw new QBError(
          'qBittorrent accepted the login but did not retain a session cookie for the next ' +
            'request. Check that cookies are enabled for the qBittorrent address.',
          'session-not-retained',
        );
      }
    }
  }

  async addOnce(url) {
    return this.request('torrents/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: this.formBody({ urls: url }),
    });
  }

  /**
   * Submit a magnet or http(s) .torrent URL via `torrents/add`.
   * The URL is never fetched by the browser/content script.
   */
  async addTorrent(url) {
    const classified = classifyUrl(url);
    if (!classified.ok) {
      throw new QBError('The link is not a valid magnet URI or .torrent URL.', 'invalid-url');
    }

    await this.ensureSession();

    let result = await this.addOnce(classified.url);
    if (result.status === 401 || result.status === 403) {
      // The session may have expired (or CSRF/login state changed). Retry once.
      this.logger.debug('Add request was rejected; retrying after login');
      await this.login();
      result = await this.addOnce(classified.url);
    }

    if (!result.ok) throw this.httpError(result, 'add');

    const text = result.text.trim();
    if (/fails?\.?$/i.test(text) || /^fails?$/i.test(text)) {
      throw new QBError(
        'qBittorrent rejected the URL. It may be malformed, already queued, or unreachable from ' +
          'the qBittorrent host.',
        'add-rejected',
        200,
      );
    }

    return { ok: true };
  }

  /** Validate settings and return version details for the options page. */
  async testConnection() {
    await this.ensureSession();

    const version = await this.getVersion();
    if (version.status === 401 || version.status === 403) {
      throw new QBError(
        'qBittorrent rejected the session while checking the connection.',
        'authentication-failed',
        version.status,
      );
    }
    if (!version.ok) throw this.httpError(version, 'version');

    let webApiVersion = null;
    const webApi = await this.getWebApiVersion();
    if (webApi.ok) webApiVersion = webApi.text.trim() || null;

    return {
      ok: true,
      message: `Connected to qBittorrent ${version.text.trim() || ''}`.trim(),
      version: version.text.trim(),
      webApiVersion,
    };
  }

  httpError(result, operation) {
    const status = result.status;
    if (status === 401) {
      return new QBError(
        `qBittorrent rejected the ${operation} request (401). Check the username/password. ` +
          'If they are correct, qBittorrent CSRF protection or the session cookie is blocking the request.',
        'unauthorized',
        status,
      );
    }
    if (status === 403) {
      return new QBError(
        `qBittorrent refused the ${operation} request (403). Your IP may be banned, the session ` +
          'may have expired, or the account lacks access.',
        'forbidden',
        status,
      );
    }
    if (status === 404) {
      return new QBError(
        'The qBittorrent Web API was not found at this base URL (404). Check the URL and any ' +
          'reverse-proxy path.',
        'not-found',
        status,
      );
    }
    if (status === 415) {
      return new QBError(
        'qBittorrent could not accept the URL (415). Check that it is a complete magnet or .torrent URL.',
        'unsupported-media',
        status,
      );
    }
    if (status >= 500) {
      return new QBError(
        `qBittorrent returned a server error (${status}). Check the qBittorrent logs and try again.`,
        'server-error',
        status,
      );
    }
    return new QBError(
      `qBittorrent returned an unexpected response (${status}) while trying to ${operation}.`,
      'http-error',
      status,
    );
  }
}
