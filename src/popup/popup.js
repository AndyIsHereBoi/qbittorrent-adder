import { MSG } from '../shared/messages.js';

const toggle = document.getElementById('enabled-toggle');
const statusDot = document.getElementById('status-dot');
const statusTitle = document.getElementById('status-title');
const statusText = document.getElementById('status-text');
const openSettings = document.getElementById('open-settings');

async function send(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch {
    return { ok: false, message: 'The extension background is not available.' };
  }
}

function setStatus(title, text, tone) {
  statusTitle.textContent = title;
  statusText.textContent = text;
  statusDot.dataset.tone = tone;
}

async function refresh() {
  const response = await send({ type: MSG.GET_STATUS });
  if (!response?.ok) {
    setStatus('Extension unavailable', response?.message || 'Reload the extension.', 'bad');
    toggle.disabled = true;
    return;
  }

  toggle.checked = response.enabled;
  toggle.disabled = false;

  if (!response.enabled) {
    setStatus('Disabled', 'Buttons are hidden on all pages.', 'warn');
    return;
  }
  if (!response.configured) {
    setStatus('Not configured', 'Add your qBittorrent URL and login in settings.', 'warn');
    return;
  }
  const method = response.authMethod === 'password' ? 'session login' : 'no login saved';
  const history =
    response.historyCount > 0 ? ` · ${response.historyCount} saved item${response.historyCount === 1 ? '' : 's'}` : '';
  setStatus('Ready', `qBittorrent at ${response.host} · ${method}${history}`, 'ok');
}

toggle.addEventListener('change', async () => {
  toggle.disabled = true;
  const response = await send({ type: MSG.SET_ENABLED, enabled: toggle.checked });
  if (!response?.ok) {
    toggle.checked = !toggle.checked;
    setStatus('Could not save', response?.message || 'Try opening settings.', 'bad');
  }
  await refresh();
});

openSettings.addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
  window.close();
});

void refresh();
