/**
 * Link scanner and per-link button UI.
 *
 * Runs in an isolated content script, renders buttons inside a shadow root, and
 * never uses innerHTML with page-provided data. The scanner watches added
 * subtrees, attributes, and text changes instead of repeatedly rescanning the
 * whole document.
 */

import { resolveDisplay } from '../shared/display.js';
import { createLogger, noopLogger } from '../shared/logger.js';
import { classifyUrl, findMagnetUrisInText } from '../shared/urls.js';

export const HOST_ATTRIBUTE = 'data-qbt-adder-host';

const ICON_PATHS = {
  idle: 'M8 1.5a.75.75 0 0 1 .75.75v6.44l2.22-2.22a.75.75 0 1 1 1.06 1.06L8 11.56 3.97 7.53a.75.75 0 0 1 1.06-1.06l2.22 2.22V2.25A.75.75 0 0 1 8 1.5ZM2.5 12.25a.75.75 0 0 1 .75.75v.25h9.5V13a.75.75 0 0 1 1.5 0v.5a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 1.75 13.5V13a.75.75 0 0 1 .75-.75Z',
  sending:
    'M8 1.5a6.5 6.5 0 1 0 6.5 6.5.75.75 0 0 0-1.5 0A5 5 0 1 1 8 3a.75.75 0 0 0 0-1.5Z',
  success:
    'M13.78 4.22a.75.75 0 0 1 0 1.06l-6.5 6.5a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06l2.47 2.47 5.97-5.97a.75.75 0 0 1 1.06 0Z',
  error:
    'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 5a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0V5Zm.75 6.25a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z',
  duplicate:
    'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm.75 3.25a.75.75 0 0 0-1.5 0V8c0 .2.08.39.22.53l1.75 1.75a.75.75 0 0 0 1.06-1.06L8.75 7.69V4.75Z',
};

const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.qbt-group {
  position: fixed;
  display: inline-flex;
  align-items: center;
  gap: calc(4px * var(--qbt-scale, 1));
  pointer-events: auto;
  font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.qbt-group[data-layout="block"] { flex-direction: column; }
.qbt-items { display: inline-flex; align-items: center; gap: calc(4px * var(--qbt-scale, 1)); }
.qbt-item { display: inline-flex; align-items: center; gap: calc(3px * var(--qbt-scale, 1)); }
.qbt-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(21px * var(--qbt-scale, 1));
  height: calc(21px * var(--qbt-scale, 1));
  border-radius: calc(5px * var(--qbt-scale, 1));
  cursor: pointer;
  background: #3b82f6;
  color: #fff;
  border: 1px solid rgba(255,255,255,.28);
  box-shadow: 0 1px 2px rgba(0,0,0,.28);
  transition: background-color .12s ease, opacity .12s ease;
}
.qbt-btn:hover { background: #2563eb; }
.qbt-btn:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
.qbt-item[data-state="sending"] .qbt-btn { background: #64748b; cursor: progress; }
.qbt-item[data-state="sending"] .qbt-icon { animation: qbt-spin .8s linear infinite; }
.qbt-item[data-state="success"] .qbt-btn { background: #16a34a; cursor: default; }
.qbt-item[data-state="error"] .qbt-btn { background: #dc2626; }
.qbt-item[data-state="duplicate"] .qbt-btn { background: #6b7280; cursor: not-allowed; opacity: .78; }
.qbt-item[data-state="exists"] .qbt-btn { background: #0f766e; cursor: default; }
.qbt-item[data-state="exists"] .qbt-status { color: #0f766e; }
.qbt-icon, .qbt-icon svg {
  display: inline-flex;
  width: calc(13px * var(--qbt-scale, 1));
  height: calc(13px * var(--qbt-scale, 1));
}
.qbt-status {
  display: none;
  padding: calc(2px * var(--qbt-scale, 1)) calc(5px * var(--qbt-scale, 1));
  border-radius: calc(3px * var(--qbt-scale, 1));
  font: 600 calc(10px * var(--qbt-scale, 1))/1.1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1e293b;
  background: rgba(255,255,255,.92);
  border: 1px solid rgba(15,23,42,.16);
  white-space: nowrap;
}
.qbt-item[data-state="success"] .qbt-status,
.qbt-item[data-state="error"] .qbt-status,
.qbt-item[data-state="exists"] .qbt-status,
.qbt-item[data-state="duplicate"] .qbt-status { display: inline-block; }
.qbt-sr {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0, 0, 0, 0) !important;
  white-space: nowrap !important;
  border: 0 !important;
}
@keyframes qbt-spin { to { transform: rotate(360deg); } }
@media (prefers-color-scheme: dark) {
  .qbt-status { color: #e2e8f0; background: rgba(15,23,42,.92); border-color: rgba(226,232,240,.22); }
}
@media (prefers-reduced-motion: reduce) {
  .qbt-item[data-state="sending"] .qbt-icon { animation: none; }
}
`;

function buildIcon(doc, state) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(svgNs, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', ICON_PATHS[state] || ICON_PATHS.idle);
  svg.append(path);
  return svg;
}

function safeText(value, max = 320) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @param {{
 *   document: Document,
 *   settings: object,
 *   submit: (url: string, kind: string) => Promise<{ok: boolean, message?: string}>,
 *   checkHistory: (items: Array<{url: string, kind: string}>) => Promise<boolean[]>,
 *   logger?: object,
 * }} options
 */
export function createScanner(options) {
  const doc = options.document;
  const win = doc.defaultView;
  const submit = options.submit;
  const checkHistory = options.checkHistory;
  const logger = options.logger || noopLogger;

  let settings = options.settings;
  let running = false;
  let observer = null;
  let scanTimer = null;
  let historyTimer = null;
  let historySeq = 0;
  const records = new Map();
  const queuedNodes = new Set();
  let overlayHost = null;
  let overlayShadow = null;
  let positionFrame = null;
  let positionInterval = null;
  let resizeObserver = null;

  function textSelectors() {
    return settings.search.textSelectors.filter((selector) => {
      try {
        doc.querySelector(selector);
        return true;
      } catch {
        logger.warn('Skipping invalid CSS selector from settings');
        return false;
      }
    });
  }

  function candidateSelectors() {
    const selectors = new Set();
    if (settings.search.magnetAnchors || settings.search.torrentLinks) selectors.add('a[href]');
    for (const attribute of settings.search.extraAttributes) selectors.add(`[${attribute}]`);
    for (const selector of textSelectors()) selectors.add(selector);
    return [...selectors];
  }

  function isOurs(element) {
    return Boolean(element?.closest?.(`[${HOST_ATTRIBUTE}]`));
  }

  function displayForDocument() {
    return resolveDisplay(settings, win.location.hostname);
  }

  function ensureOverlay() {
    if (overlayHost?.isConnected) return;
    overlayHost = doc.createElement('div');
    overlayHost.setAttribute(HOST_ATTRIBUTE, '');
    overlayHost.setAttribute('aria-hidden', 'false');
    overlayHost.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important; ' +
      'display: block !important; pointer-events: none !important; z-index: 2147483647 !important; ' +
      'margin: 0 !important; padding: 0 !important; border: 0 !important; overflow: visible !important;';
    overlayShadow = overlayHost.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = CSS;
    overlayShadow.append(style);
    overlayHost.style.setProperty(
      '--qbt-scale',
      String((Number(settings.display?.scale) || 100) / 100),
    );
    (doc.documentElement || doc.body).append(overlayHost);
  }

  function destroyOverlay() {
    overlayHost?.remove();
    overlayHost = null;
    overlayShadow = null;
  }

  function makeGroup(layout) {
    ensureOverlay();
    const group = doc.createElement('span');
    group.className = 'qbt-group';
    group.setAttribute('data-qbt-group', '');
    group.setAttribute('data-layout', layout);
    const items = doc.createElement('span');
    items.className = 'qbt-items';
    group.append(items);
    overlayShadow.append(group);
    return { host: group, group, items };
  }

  function schedulePositionUpdate() {
    if (!running || positionFrame !== null) return;
    positionFrame = win.requestAnimationFrame(() => {
      positionFrame = null;
      positionAll();
    });
  }

  function positionRecord(record) {
    const { target, group } = record;
    if (!target.isConnected || record.items.size === 0) {
      group.style.display = 'none';
      return;
    }

    const rect = target.getBoundingClientRect();
    const viewportWidth = win.innerWidth;
    const viewportHeight = win.innerHeight;
    if (
      !rect ||
      (rect.width === 0 && rect.height === 0) ||
      rect.bottom < 0 ||
      rect.top > viewportHeight
    ) {
      group.style.display = 'none';
      return;
    }

    group.style.visibility = 'hidden';
    group.style.display = 'inline-flex';
    const width = group.offsetWidth || 0;
    const height = group.offsetHeight || 0;

    const gap = 4;
    const minMargin = 4;
    let left = record.placement === 'before' ? rect.left - width - gap : rect.right + gap;
    let top = rect.top + (rect.height - height) / 2;

    if (left + width > viewportWidth - minMargin) {
      const alternate = rect.left - width - gap;
      if (alternate >= minMargin) left = alternate;
    }
    if (left < minMargin) left = Math.min(viewportWidth - width - minMargin, rect.left);
    if (left < minMargin) left = minMargin;
    top = Math.max(minMargin, Math.min(viewportHeight - height - minMargin, top));

    group.style.left = `${Math.round(left)}px`;
    group.style.top = `${Math.round(top)}px`;
    group.style.visibility = '';
  }

  function positionAll() {
    if (!running) return;
    for (const record of records.values()) positionRecord(record);
  }

  function makeItem(kind) {
    const element = doc.createElement('span');
    element.className = 'qbt-item';
    element.setAttribute('data-state', 'idle');

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'qbt-btn';

    const icon = doc.createElement('span');
    icon.className = 'qbt-icon';

    const status = doc.createElement('span');
    status.className = 'qbt-status';
    status.setAttribute('aria-hidden', 'true');

    const live = doc.createElement('span');
    live.className = 'qbt-sr';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');

    button.append(icon);
    element.append(button, status, live);
    return { element, button, icon, status, live, kind };
  }

  function labelsFor(kind, state) {
    const noun = kind === 'magnet' ? 'magnet' : '.torrent';
    switch (state) {
      case 'sending':
        return { label: `Adding ${noun} to qBittorrent…`, text: 'Sending…' };
      case 'success':
        return { label: `${noun === 'magnet' ? 'Magnet' : 'Torrent'} added to qBittorrent`, text: 'Added' };
      case 'error':
        return { label: `Failed to add ${noun}. Click to retry.`, text: 'Failed' };
      case 'duplicate':
        return { label: `${noun === 'magnet' ? 'Magnet' : 'Torrent'} already in submission history`, text: 'In history' };
      case 'exists':
        return { label: `${noun === 'magnet' ? 'Magnet' : 'Torrent'} already in qBittorrent`, text: 'In qBittorrent' };
      default:
        return {
          label: kind === 'magnet' ? 'Add magnet to qBittorrent' : 'Add .torrent to qBittorrent',
          text: '',
        };
    }
  }

  function setState(item, state, detail = '') {
    item.state = state;
    item.element.setAttribute('data-state', state);
    item.button.disabled =
      state === 'sending' ||
      state === 'success' ||
      state === 'duplicate' ||
      state === 'exists';
    const labels = labelsFor(item.kind, state);
    const title = detail || labels.label;
    item.button.setAttribute('aria-label', labels.label);
    item.button.title = title;
    item.status.textContent = state === 'sending' ? labels.text : labels.text;
    item.live.textContent = detail || labels.text || '';
    item.icon.replaceChildren(buildIcon(doc, state));
  }

  function removeRecord(target) {
    const record = records.get(target);
    if (!record) return;
    resizeObserver?.unobserve(target);
    record.host.remove();
    records.delete(target);
    if (records.size === 0) destroyOverlay();
  }

  function removeItem(record, key) {
    const item = record.items.get(key);
    if (!item) return;
    item.element.remove();
    record.items.delete(key);
    if (record.items.size === 0) {
      const target = record.target;
      removeRecord(target);
    } else {
      schedulePositionUpdate();
    }
  }

  function ensureRecord(target) {
    const display = displayForDocument();
    if (display.hidden || target === doc.documentElement || target === doc.body) return null;

    let record = records.get(target);
    if (record && record.host.isConnected) return record;
    if (record) removeRecord(target);

    const { host, group, items } = makeGroup(display.layout);
    group.setAttribute('data-placement', display.placement);

    record = {
      target,
      host,
      group,
      layout: display.layout,
      placement: display.placement,
    };
    record.items = new Map();
    record.itemsContainer = items;
    records.set(target, record);
    resizeObserver?.observe(target);
    schedulePositionUpdate();
    return record;
  }

  function addItem(target, key, match) {
    const record = ensureRecord(target);
    if (!record || record.items.has(key)) return;

    const item = makeItem(match.kind);
    item.url = match.url;
    item.key = key;
    item.target = target;
    record.items.set(key, item);
    record.itemsContainer.append(item.element);

    const refreshLabels = labelsFor(match.kind, 'idle');
    item.button.setAttribute('aria-label', refreshLabels.label);
    item.button.title = refreshLabels.label;
    item.icon.replaceChildren(buildIcon(doc, 'idle'));
    item.state = 'idle';

    item.button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void handleClick(item);
    });
    item.button.addEventListener('auxclick', (event) => event.stopPropagation());

    schedulePositionUpdate();
    scheduleHistoryRefresh();
  }

  async function handleClick(item) {
    if (item.state === 'sending' || item.state === 'success' || item.state === 'duplicate') return;
    setState(item, 'sending');

    try {
      const result = await submit(item.url, item.kind);
      if (!result || result.ok === false) {
        throw new Error(result?.message || 'qBittorrent did not accept the link.');
      }
      if (result.duplicate) {
        setState(item, 'exists', result.message || 'This torrent is already in qBittorrent.');
        return;
      }
      setState(
        item,
        'success',
        result.message ||
          (item.kind === 'magnet' ? 'Magnet added to qBittorrent.' : 'Torrent added to qBittorrent.'),
      );
    } catch (error) {
      const message = safeText(error?.message || 'Could not add this link to qBittorrent.');
      logger.warn('Could not submit link', { kind: item.kind, error: safeText(error?.name || 'Error', 40) });
      setState(item, 'error', `${message} Click to retry.`);
    }
  }

  function collectMatches(element) {
    const matches = new Map();

    if (element.matches?.('a[href]')) {
      const raw = element.getAttribute('href') || '';
      const classified = classifyUrl(raw, doc.baseURI);
      if (classified.ok) {
        if (
          (classified.kind === 'magnet' && settings.search.magnetAnchors) ||
          (classified.kind === 'torrent' && settings.search.torrentLinks)
        ) {
          matches.set(`${classified.kind}:${classified.url}`, classified);
        }
      }
    }

    for (const attribute of settings.search.extraAttributes) {
      const raw = element.getAttribute?.(attribute);
      if (!raw) continue;
      for (const magnet of findMagnetUrisInText(raw)) {
        matches.set(`magnet:${magnet.uri}`, { kind: 'magnet', url: magnet.uri });
      }
    }

    const textSelectorsForElement = textSelectors();
    if (textSelectorsForElement.some((selector) => element.matches?.(selector))) {
      const text = element.textContent || '';
      if (text.length > 0 && text.length <= 200_000) {
        for (const magnet of findMagnetUrisInText(text)) {
          matches.set(`magnet:${magnet.uri}`, { kind: 'magnet', url: magnet.uri });
        }
      }
    }

    return matches;
  }

  function syncElement(element) {
    if (!element || element.nodeType !== 1 || isOurs(element)) return;
    const matches = collectMatches(element);
    const record = records.get(element);

    if (matches.size === 0) {
      if (record) removeRecord(element);
      return;
    }

    const activeRecord = ensureRecord(element);
    if (!activeRecord) return;

    for (const key of [...activeRecord.items.keys()]) {
      if (!matches.has(key)) removeItem(activeRecord, key);
    }
    for (const [key, match] of matches) addItem(element, key, match);
  }

  function scanRoot(root) {
    if (!root) return;
    if (root.nodeType === 9) {
      for (const selector of candidateSelectors()) {
        try {
          for (const element of root.querySelectorAll(selector)) syncElement(element);
        } catch {
          logger.warn('A configured selector could not be queried');
        }
      }
      return;
    }
    if (root.nodeType !== 1 || isOurs(root)) return;

    const selectors = candidateSelectors();
    if (selectors.some((selector) => root.matches?.(selector))) syncElement(root);
    for (const selector of selectors) {
      try {
        for (const element of root.querySelectorAll(selector)) syncElement(element);
      } catch {
        logger.warn('A configured selector could not be queried');
      }
    }
  }

  function scanAll() {
    cleanupDisconnected();
    scanRoot(doc);
    schedulePositionUpdate();
    scheduleHistoryRefresh();
  }

  function cleanupDisconnected() {
    for (const [target, record] of [...records]) {
      if (!target.isConnected) {
        removeRecord(target);
        continue;
      }
      if (!record.host.isConnected) {
        records.delete(target);
        queuedNodes.add(target);
        scheduleQueuedScan(0);
      }
    }
  }

  function scheduleQueuedScan(delay = 150) {
    if (!running || scanTimer !== null) return;
    scanTimer = win.setTimeout(() => {
      scanTimer = null;
      const nodes = [...queuedNodes];
      queuedNodes.clear();
      cleanupDisconnected();
      for (const node of nodes) {
        if (node?.isConnected) scanRoot(node);
      }
      schedulePositionUpdate();
      scheduleHistoryRefresh();
    }, delay);
  }

  function nearestTextElement(node) {
    let element = node?.parentElement;
    const selectors = textSelectors();
    if (!element || selectors.length === 0) return null;
    while (element && element !== doc.documentElement) {
      try {
        if (selectors.some((selector) => element.matches(selector))) return element;
      } catch {
        return null;
      }
      element = element.parentElement;
    }
    return null;
  }

  function onMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1 && !isOurs(node)) queuedNodes.add(node);
        }
        for (const node of mutation.removedNodes) {
          if (node.nodeType === 1) queuedNodes.add(node);
        }
      } else if (mutation.type === 'attributes') {
        if (!isOurs(mutation.target)) queuedNodes.add(mutation.target);
      } else if (mutation.type === 'characterData') {
        const element = nearestTextElement(mutation.target);
        if (element) queuedNodes.add(element);
      }
    }
    if (queuedNodes.size > 0) scheduleQueuedScan();
  }

  function onViewportChange() {
    schedulePositionUpdate();
  }

  function startObserving() {
    if (observer || !doc.documentElement) return;
    const attributeFilter = ['href', ...settings.search.extraAttributes];
    observer = new win.MutationObserver(onMutations);
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter,
    });
    win.addEventListener('scroll', onViewportChange, true);
    win.addEventListener('resize', onViewportChange);
    if (typeof win.ResizeObserver === 'function') {
      resizeObserver = new win.ResizeObserver(() => schedulePositionUpdate());
      for (const target of records.keys()) resizeObserver.observe(target);
    }
    if (positionInterval === null) {
      positionInterval = win.setInterval(schedulePositionUpdate, 500);
    }
  }

  function scheduleHistoryRefresh(delay = 180) {
    if (!running) return;
    if (historyTimer !== null) return;
    historyTimer = win.setTimeout(() => {
      historyTimer = null;
      void refreshHistory();
    }, delay);
  }

  async function refreshHistory() {
    if (!running) return;
    const items = [];
    for (const record of records.values()) {
      for (const item of record.items.values()) {
        if (item.state === 'idle' || item.state === 'duplicate') items.push(item);
      }
    }
    if (items.length === 0) return;

    const seq = ++historySeq;
    let duplicates;
    try {
      duplicates = await checkHistory(items.map((item) => ({ url: item.url, kind: item.kind })));
    } catch {
      logger.warn('Could not check local submission history');
      return;
    }
    if (seq !== historySeq) return;

    const disableDuplicates = settings.history.duplicateMode === 'disable';
    const seen = new Set();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item.element.isConnected) continue;
      const known = Boolean(duplicates?.[index]);
      if (known && disableDuplicates) {
        setState(item, 'duplicate');
      } else if (item.state === 'duplicate') {
        setState(item, 'idle');
      }
      seen.add(item.key);
    }
    void seen;
  }

  function start() {
    if (running) return;
    running = true;
    startObserving();
    scanAll();
  }

  function stop() {
    running = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    win.removeEventListener('scroll', onViewportChange, true);
    win.removeEventListener('resize', onViewportChange);
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (positionInterval !== null) {
      win.clearInterval(positionInterval);
      positionInterval = null;
    }
    if (positionFrame !== null) {
      win.cancelAnimationFrame(positionFrame);
      positionFrame = null;
    }
    if (scanTimer !== null) {
      win.clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (historyTimer !== null) {
      win.clearTimeout(historyTimer);
      historyTimer = null;
    }
    queuedNodes.clear();
    for (const target of [...records.keys()]) removeRecord(target);
    destroyOverlay();
  }

  function updateSettings(next) {
    settings = next;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    win.removeEventListener('scroll', onViewportChange, true);
    win.removeEventListener('resize', onViewportChange);
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (positionInterval !== null) {
      win.clearInterval(positionInterval);
      positionInterval = null;
    }
    if (positionFrame !== null) {
      win.cancelAnimationFrame(positionFrame);
      positionFrame = null;
    }
    if (scanTimer !== null) {
      win.clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (historyTimer !== null) {
      win.clearTimeout(historyTimer);
      historyTimer = null;
    }
    queuedNodes.clear();
    for (const target of [...records.keys()]) removeRecord(target);
    destroyOverlay();
    if (running) {
      startObserving();
      scanAll();
    }
  }

  function getRecords() {
    return [...records.values()].map((record) => ({
      target: record.target,
      host: record.host,
      items: [...record.items.values()],
    }));
  }

  return {
    start,
    stop,
    updateSettings,
    scanAll,
    scanNode: scanRoot,
    refreshHistory,
    getRecords,
    get running() {
      return running;
    },
  };
}
