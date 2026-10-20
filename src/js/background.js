/*
 * The only part of the extension that talks to the network, and only to the
 * bridge on http://127.0.0.1:<port>. Content scripts ask it with
 * {type: 'bridge', method, path, body}; GitHub's page CSP doesn't apply here.
 */
import { getSettings } from './shared/settings.js';

const METHODS = new Set(['GET', 'POST']);

async function callBridge({ method = 'GET', path, body }) {
  if (!METHODS.has(method) || typeof path !== 'string' || !/^\/api\/[A-Za-z0-9._~%/?=&-]*$/.test(path) || path.includes('..')) {
    return { ok: false, status: 0, error: 'bad request' };
  }
  const { port, token } = await getSettings();
  if (!token) return { ok: false, status: 0, error: 'not-configured' };
  try {
    const res = await fetch(`http://127.0.0.1:${Number(port)}${path}`, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { ok: res.ok, status: res.status, body: json, error: res.ok ? null : (json && json.error) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: 'unreachable' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || msg.type !== 'bridge') return false;
  callBridge(msg).then(sendResponse);
  return true;
});

function toggle(tab) {
  if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
}
chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-panel') return;
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  toggle(target);
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { token } = await getSettings();
  if (reason === 'install' && !token) chrome.runtime.openOptionsPage();
});
