/*
 * The only part of the extension that talks to the network, and only to the
 * bridge on http://127.0.0.1:<port>. Content scripts ask it with
 * {type: 'bridge', method, path, body}; GitHub's page CSP doesn't apply here.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { getSettings, type BridgeSettings } from '../settings.ts';
import type { BridgeReply, BridgeRequest } from '../content/bridge.ts';

const METHODS = new Set(['GET', 'POST']);

async function callBridge(
  { method = 'GET', path, body }: BridgeRequest,
  override: BridgeSettings | null,
): Promise<BridgeReply> {
  if (
    !METHODS.has(method) ||
    typeof path !== 'string' ||
    !/^\/api\/[A-Za-z0-9._~%/?=&-]*$/.test(path) ||
    path.includes('..')
  ) {
    return { ok: false, status: 0, error: 'bad request' };
  }
  // the options page can test the values in its form before they're saved
  const { port, token } = override || (await getSettings());
  if (!token) {
    return { ok: false, status: 0, error: 'not-configured' };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${Number(port)}${path}`, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: { error?: string } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      body: json,
      error: res.ok ? null : (json && json.error) || `HTTP ${res.status}`,
    };
  } catch {
    return { ok: false, status: 0, error: 'unreachable' };
  }
}

/** The review inbox page's link (with its key) is the bridge's to make; only a link to the bridge's own /inbox/ is opened. */
const isInboxLink = (url: unknown): url is string =>
  typeof url === 'string' &&
  /^http:\/\/127\.0\.0\.1:\d{2,5}\/inbox\/#key=page\.[A-Za-z0-9_-]+(&repo=[A-Za-z0-9_.%-]+)?$/.test(
    url,
  );

/** Opens the review inbox page in a tab (the keyboard command; the options page has a button for it too). */
async function openInbox() {
  const answer = await callBridge({ type: 'bridge', path: '/api/inbox/link' }, null);
  const url = (answer.body as { url?: unknown } | null | undefined)?.url;
  if (answer.ok && isInboxLink(url)) {
    chrome.tabs.create({ url });
  }
}

function toggle(tab: chrome.tabs.Tab | undefined) {
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg: BridgeRequest | null, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg || msg.type !== 'bridge') {
      return false;
    }
    // only the extension's own pages (the options page) may pass unsaved settings; content scripts run on github.com
    const ownPage =
      typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
    const unsaved =
      ownPage && msg.settings && typeof msg.settings === 'object'
        ? { port: Number(msg.settings.port), token: String(msg.settings.token || '') }
        : null;
    callBridge(msg, unsaved).then(sendResponse);
    return true;
  });

  chrome.action.onClicked.addListener(toggle);
  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === 'open-inbox') {
      await openInbox();
      return;
    }
    if (command !== 'toggle-panel') {
      return;
    }
    const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    toggle(target);
  });

  chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    const { token } = await getSettings();
    if (reason === 'install' && !token) {
      chrome.runtime.openOptionsPage();
    }
  });
});
