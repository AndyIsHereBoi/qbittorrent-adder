import { describe, expect, it } from 'vitest';
import {
  isValidHostnameRule,
  normalizeBaseUrl,
  publicSettings,
  validateCredentials,
  validateSettings,
} from '../src/shared/settings-schema.js';

describe('base URL validation', () => {
  it('adds http:// when the scheme is missing and removes trailing slashes', () => {
    expect(normalizeBaseUrl('192.168.1.10:8080/').value).toBe('http://192.168.1.10:8080');
    expect(normalizeBaseUrl('https://example.net/qbt///').value).toBe('https://example.net/qbt');
  });

  it('accepts an empty value as not configured', () => {
    expect(normalizeBaseUrl('')).toEqual({ ok: true, value: '' });
    expect(normalizeBaseUrl(undefined)).toEqual({ ok: true, value: '' });
  });

  it('rejects credentials, queries, fragments and non-http schemes', () => {
    expect(normalizeBaseUrl('https://user:pass@example.net').ok).toBe(false);
    expect(normalizeBaseUrl('https://example.net/?x=1').ok).toBe(false);
    expect(normalizeBaseUrl('https://example.net/#x').ok).toBe(false);
    expect(normalizeBaseUrl('ftp://example.net').ok).toBe(false);
    expect(normalizeBaseUrl('not a url').ok).toBe(false);
  });
});

describe('settings validation', () => {
  it('fills safe defaults', () => {
    const { settings, errors } = validateSettings({});
    expect(errors).toEqual([]);
    expect(settings.enabled).toBe(true);
    expect(settings.search.magnetAnchors).toBe(true);
    expect(settings.search.torrentLinks).toBe(true);
    expect(settings.search.textSelectors).toEqual(['code']);
    expect(settings.display.placement).toBe('after');
    expect(settings.history.duplicateMode).toBe('allow');
    expect(settings.debug).toBe(false);
  });

  it('sanitises attributes, selectors, site rules and enums', () => {
    const { settings, errors } = validateSettings({
      search: {
        extraAttributes: ['data-magnet', 'not valid!', 'data-magnet'],
        textSelectors: ['code', '.magnet', 'bad<selector'],
      },
      display: {
        placement: 'sideways',
        layout: 'block',
        siteRules: [
          { hostname: 'Example.COM', enabled: false, placement: 'before', layout: 'inline' },
          { hostname: '*.example.org', placement: 'nonsense', layout: 'nonsense' },
          { hostname: 'invalid/path' },
        ],
      },
      history: { maxEntries: 1, duplicateMode: 'always' },
      debug: 'yes',
    });

    expect(settings.search.extraAttributes).toEqual(['data-magnet']);
    expect(settings.search.textSelectors).toEqual(['code', '.magnet']);
    expect(settings.display.placement).toBe('after');
    expect(settings.display.layout).toBe('block');
    expect(settings.display.siteRules).toHaveLength(2);
    expect(settings.display.siteRules[0].hostname).toBe('example.com');
    expect(settings.display.siteRules[1].placement).toBe('default');
    expect(settings.history.maxEntries).toBe(10);
    expect(settings.history.duplicateMode).toBe('allow');
    expect(settings.debug).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects an invalid base URL', () => {
    const { settings, errors } = validateSettings({ connection: { baseUrl: 'https://user:pass@x' } });
    expect(errors.length).toBeGreaterThan(0);
    expect(settings.connection.baseUrl).toBe('');
  });

  it('limits list sizes', () => {
    const { settings } = validateSettings({
      search: {
        extraAttributes: Array.from({ length: 50 }, (_, index) => `data-${index}`),
        textSelectors: Array.from({ length: 50 }, (_, index) => `.item-${index}`),
      },
      display: {
        siteRules: Array.from({ length: 150 }, (_, index) => ({ hostname: `site-${index}.example` })),
      },
    });
    expect(settings.search.extraAttributes).toHaveLength(20);
    expect(settings.search.textSelectors).toHaveLength(20);
    expect(settings.display.siteRules).toHaveLength(100);
  });

  it('validates hostname rules', () => {
    expect(isValidHostnameRule('example.com')).toBe(true);
    expect(isValidHostnameRule('*.example.com')).toBe(true);
    expect(isValidHostnameRule('sub-domain.example.com')).toBe(true);
    expect(isValidHostnameRule('https://example.com')).toBe(false);
    expect(isValidHostnameRule('example.com/path')).toBe(false);
    expect(isValidHostnameRule('')).toBe(false);
  });

  it('exposes no credentials or qBittorrent URL to content scripts', () => {
    const { settings } = validateSettings({
      connection: { baseUrl: 'http://localhost:8080' },
      debug: true,
    });
    const shared = publicSettings(settings);
    expect(shared.connection).toBeUndefined();
    expect(shared.credentials).toBeUndefined();
    expect(JSON.stringify(shared)).not.toContain('localhost');
    expect(shared.debug).toBe(true);
  });
});

describe('credential validation', () => {
  it('accepts username/password', () => {
    expect(validateCredentials({ username: 'admin', password: 'secret' }).errors).toEqual([]);
  });

  it('requires a username when a password is present', () => {
    expect(validateCredentials({ username: '', password: 'secret' }).errors.length).toBe(1);
  });

  it('rejects overly long values', () => {
    expect(validateCredentials({ username: 'x'.repeat(600) }).errors.length).toBe(1);
    expect(validateCredentials({ password: 'x'.repeat(3000), username: 'a' }).errors.length).toBe(1);
  });
});
