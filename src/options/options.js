import { MSG } from '../shared/messages.js';
import {
  isUsableSelector,
  isValidHostnameRule,
  normalizeBaseUrl,
  validateCredentials,
  validateSettings,
} from '../shared/settings-schema.js';

const $ = (id) => document.getElementById(id);

const form = $('settings-form');
const baseUrlInput = $('base-url');
const usernameInput = $('username');
const passwordInput = $('password');
const enabledInput = $('enabled');
const magnetAnchorsInput = $('magnet-anchors');
const torrentLinksInput = $('torrent-links');
const extraAttributesInput = $('extra-attributes');
const textSelectorsInput = $('text-selectors');
const debugInput = $('debug');
const placementInput = $('placement');
const layoutInput = $('layout');
const scaleRangeInput = $('scale-range');
const scaleNumberInput = $('scale-number');
const historyEnabledInput = $('history-enabled');
const duplicateModeInput = $('duplicate-mode');
const historyBody = $('history-body');
const historyStatus = $('history-status');
const siteRulesBody = $('site-rules-body');
const saveStatus = $('save-status');
const testStatus = $('test-status');
const testButton = $('test-connection');
const saveButton = $('save-settings');

let siteRules = [];
let historyMaxEntries = 500;

async function send(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch {
    return { ok: false, message: 'The extension background is not available. Reload the extension.' };
  }
}

function setStatus(element, text, tone = '') {
  element.textContent = text;
  if (tone) element.dataset.tone = tone;
  else delete element.dataset.tone;
}

function splitLines(value) {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function collectForm() {
  const settings = {
    version: 1,
    enabled: enabledInput.checked,
    connection: { baseUrl: baseUrlInput.value },
    search: {
      magnetAnchors: magnetAnchorsInput.checked,
      torrentLinks: torrentLinksInput.checked,
      extraAttributes: splitLines(extraAttributesInput.value),
      textSelectors: splitLines(textSelectorsInput.value),
    },
    display: {
      placement: placementInput.value,
      layout: layoutInput.value,
      scale: Number(scaleNumberInput.value),
      siteRules: siteRules.map((rule) => ({ ...rule })),
    },
    history: {
      enabled: historyEnabledInput.checked,
      duplicateMode: duplicateModeInput.value,
      maxEntries: historyMaxEntries,
    },
    debug: debugInput.checked,
  };
  const credentials = {
    username: usernameInput.value,
    password: passwordInput.value,
  };
  return { settings, credentials };
}

function validateForm(settings, credentials) {
  const settingsResult = validateSettings(settings);
  const credentialsResult = validateCredentials(credentials);
  const errors = [...settingsResult.errors, ...credentialsResult.errors];

  for (const selector of settingsResult.settings.search.textSelectors) {
    if (!isUsableSelector(selector, document)) {
      errors.push(`Invalid CSS selector: "${selector}".`);
    }
  }

  return { settings: settingsResult.settings, credentials: credentialsResult.credentials, errors };
}

function renderSiteRules() {
  siteRulesBody.replaceChildren();
  if (siteRules.length === 0) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'No per-site rules.';
    row.append(cell);
    siteRulesBody.append(row);
    return;
  }

  for (const rule of siteRules) {
    const row = document.createElement('tr');
    const hostCell = document.createElement('td');
    hostCell.textContent = rule.hostname;
    const enabledCell = document.createElement('td');
    enabledCell.textContent = rule.enabled ? 'Show' : 'Hide';
    const placementCell = document.createElement('td');
    placementCell.textContent = rule.placement === 'default' ? 'Default' : rule.placement;
    const layoutCell = document.createElement('td');
    layoutCell.textContent = rule.layout === 'default' ? 'Default' : rule.layout;
    const actionCell = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove rule for ${rule.hostname}`);
    remove.addEventListener('click', () => {
      siteRules = siteRules.filter((item) => item.hostname !== rule.hostname);
      renderSiteRules();
    });
    actionCell.append(remove);
    row.append(hostCell, enabledCell, placementCell, layoutCell, actionCell);
    siteRulesBody.append(row);
  }
}

function addSiteRule() {
  const hostname = $('rule-hostname').value.trim().toLowerCase();
  if (!hostname) {
    setStatus(saveStatus, 'Enter a hostname for the site rule.', 'bad');
    return;
  }
  if (!isValidHostnameRule(hostname)) {
    setStatus(saveStatus, 'Enter a hostname such as example.com or *.example.com.', 'bad');
    return;
  }
  if (siteRules.length >= 100 && !siteRules.some((rule) => rule.hostname === hostname)) {
    setStatus(saveStatus, 'Too many per-site rules (maximum 100).', 'bad');
    return;
  }

  const rule = {
    hostname,
    enabled: $('rule-enabled').value === 'true',
    placement: $('rule-placement').value,
    layout: $('rule-layout').value,
  };
  const existing = siteRules.findIndex((item) => item.hostname === hostname);
  if (existing >= 0) siteRules[existing] = rule;
  else siteRules.push(rule);
  $('rule-hostname').value = '';
  renderSiteRules();
  setStatus(saveStatus, 'Site rule added. Save settings to apply it.', 'warn');
}

function renderHistory(entries) {
  historyBody.replaceChildren();
  if (!Array.isArray(entries) || entries.length === 0) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'No submissions recorded.';
    row.append(cell);
    historyBody.append(row);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.textContent = String(entry.name || 'Unnamed');
    const kindCell = document.createElement('td');
    kindCell.textContent = entry.kind === 'magnet' ? 'Magnet' : '.torrent';
    const pageCell = document.createElement('td');
    pageCell.textContent = String(entry.pageHostname || '—');
    const dateCell = document.createElement('td');
    const timestamp = Number(entry.addedAt);
    dateCell.textContent = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : '—';
    const urlCell = document.createElement('td');
    const url = document.createElement('span');
    url.className = 'display-url';
    url.textContent = String(entry.displayUrl || '');
    urlCell.append(url);
    row.append(nameCell, kindCell, pageCell, dateCell, urlCell);
    historyBody.append(row);
  }
}

async function refreshHistory() {
  const response = await send({ type: MSG.GET_HISTORY });
  if (!response?.ok) {
    renderHistory([]);
    setStatus(historyStatus, response?.message || 'Could not load history.', 'bad');
    return;
  }
  renderHistory(response.entries);
  const count = response.entries?.length || 0;
  setStatus(historyStatus, `${count} entr${count === 1 ? 'y' : 'ies'} stored locally.`, '');
}

async function load(attempt = 0) {
  const response = await send({ type: MSG.GET_CONFIG });
  if (!response?.ok) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return load(attempt + 1);
    }
    setStatus(saveStatus, response?.message || 'Could not load settings.', 'bad');
    return;
  }

  const { settings, credentials } = response;
  baseUrlInput.value = settings.connection.baseUrl;
  usernameInput.value = credentials.username || '';
  passwordInput.value = credentials.password || '';
  enabledInput.checked = settings.enabled;
  magnetAnchorsInput.checked = settings.search.magnetAnchors;
  torrentLinksInput.checked = settings.search.torrentLinks;
  extraAttributesInput.value = settings.search.extraAttributes.join('\n');
  textSelectorsInput.value = settings.search.textSelectors.join('\n');
  debugInput.checked = settings.debug;
  placementInput.value = settings.display.placement;
  layoutInput.value = settings.display.layout;
  scaleRangeInput.value = String(settings.display.scale);
  scaleNumberInput.value = String(settings.display.scale);
  historyEnabledInput.checked = settings.history.enabled;
  duplicateModeInput.value = settings.history.duplicateMode;
  historyMaxEntries = settings.history.maxEntries;
  siteRules = settings.display.siteRules.map((rule) => ({ ...rule }));
  renderSiteRules();
  await refreshHistory();
}

async function save(event) {
  event.preventDefault();
  saveButton.disabled = true;
  setStatus(saveStatus, 'Saving…');

  const collected = collectForm();
  const checked = validateForm(collected.settings, collected.credentials);
  if (checked.errors.length > 0) {
    setStatus(saveStatus, checked.errors[0], 'bad');
    saveButton.disabled = false;
    return;
  }

  baseUrlInput.value = checked.settings.connection.baseUrl;

  const response = await send({
    type: MSG.SAVE_CONFIG,
    settings: checked.settings,
    credentials: checked.credentials,
  });

  if (!response?.ok) {
    setStatus(saveStatus, response?.errors?.[0] || response?.message || 'Could not save settings.', 'bad');
    saveButton.disabled = false;
    return;
  }

  setStatus(saveStatus, 'Settings saved.', 'ok');
  saveButton.disabled = false;
  await refreshHistory();
}

async function testConnection() {
  testButton.disabled = true;
  setStatus(testStatus, 'Connecting…');

  const collected = collectForm();
  const checked = validateForm(collected.settings, collected.credentials);
  if (checked.errors.length > 0) {
    setStatus(testStatus, checked.errors[0], 'bad');
    testButton.disabled = false;
    return;
  }

  baseUrlInput.value = checked.settings.connection.baseUrl;

  const response = await send({
    type: MSG.TEST_CONNECTION,
    settings: checked.settings,
    credentials: checked.credentials,
  });

  if (!response?.ok) {
    setStatus(testStatus, response?.message || 'Connection failed.', 'bad');
  } else {
    const api = response.webApiVersion ? `, Web API ${response.webApiVersion}` : '';
    setStatus(testStatus, `${response.message}${api}.`, 'ok');
  }
  testButton.disabled = false;
}

async function clearHistory() {
  if (!window.confirm('Clear the local submission history? This cannot be undone.')) return;
  const response = await send({ type: MSG.CLEAR_HISTORY });
  if (!response?.ok) {
    setStatus(historyStatus, response?.message || 'Could not clear history.', 'bad');
    return;
  }
  await refreshHistory();
  setStatus(historyStatus, 'History cleared.', 'ok');
}

form.addEventListener('submit', (event) => void save(event));
testButton.addEventListener('click', () => void testConnection());
$('add-rule').addEventListener('click', addSiteRule);
$('refresh-history').addEventListener('click', () => void refreshHistory());
$('clear-history').addEventListener('click', () => void clearHistory());
scaleRangeInput.addEventListener('input', () => {
  scaleNumberInput.value = scaleRangeInput.value;
});
scaleNumberInput.addEventListener('input', () => {
  const value = Number(scaleNumberInput.value);
  if (Number.isFinite(value) && value >= 50 && value <= 200) {
    scaleRangeInput.value = String(value);
  }
});
baseUrlInput.addEventListener('blur', () => {
  const normalised = normalizeBaseUrl(baseUrlInput.value);
  if (normalised.ok && normalised.value) baseUrlInput.value = normalised.value;
});

void load();
