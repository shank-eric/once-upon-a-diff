/*
 * The only part of the extension that talks to the network, and only to the
 * bridge on http://127.0.0.1:<port>. Content scripts ask it with
 * {type: 'bridge', method, path, body}; GitHub's page CSP doesn't apply here.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { getSettings, type BridgeSettings } from '../settings.ts';
import { matchRoute } from '@once-upon-a-diff/bridge-client/client';
import { EXTENSION_ROUTES } from '../bridge-routes.ts';
import { isPageLink, type PageKind } from '../page-links.ts';
import type { BridgeAbort, BridgeReply, BridgeRequest } from '../content/bridge.ts';

const METHODS = new Set(['GET', 'POST']);

/** The fetches out for a call that has an id (a poll's), so a page's `bridge-abort` can close one. */
const cancellable = new Map<string, AbortController>();

async function callBridge(
  { method = 'GET', path, body }: BridgeRequest,
  override: BridgeSettings | null,
  signal?: AbortSignal,
): Promise<BridgeReply> {
  // only a call to one of the routes the extension makes (bridge-routes.ts), with its method: the token goes with nothing else
  if (
    !METHODS.has(method) ||
    typeof path !== 'string' ||
    !matchRoute(method, path, EXTENSION_ROUTES)
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
      signal,
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

/**
 * Opens the board in a tab (the keyboard command; the options page has a button too). The link, with
 * its key, is the bridge's to make: `public=1` asks for the proxy's address (https://once-upon.test) when it reaches this
 * machine, so the page sets its cookie in this browser, and else the bridge's own. Only a link of the right shape is opened.
 */
async function openPage(kind: PageKind) {
  const answer = await callBridge({ type: 'bridge', path: '/api/board/link?public=1' }, null);
  const url = (answer.body as { url?: unknown } | null | undefined)?.url;
  if (answer.ok && isPageLink(kind, url)) {
    chrome.tabs.create({ url });
  }
}

/** Counts a toolbar or shortcut use now: a rare event in the service worker, so one call, no batching. Names only. */
function countNow(
  name: 'ext.toolbar.toggle' | 'ext.shortcut.togglePanel' | 'ext.shortcut.openBoard',
) {
  void callBridge(
    { type: 'bridge', method: 'POST', path: '/api/usage', body: { counts: { [name]: 1 } } },
    null,
  );
}

function toggle(tab: chrome.tabs.Tab | undefined) {
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener(
    (msg: BridgeRequest | BridgeAbort | null, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || !msg) {
        return false;
      }
      if (msg.type === 'bridge-abort') {
        if (typeof msg.id === 'string') {
          cancellable.get(msg.id)?.abort();
        }
        return false;
      }
      if (msg.type !== 'bridge') {
        return false;
      }
      // only the extension's own pages (the options page) may pass unsaved settings; content scripts run on github.com
      const ownPage =
        typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
      const unsaved =
        ownPage && msg.settings && typeof msg.settings === 'object'
          ? { port: Number(msg.settings.port), token: String(msg.settings.token || '') }
          : null;
      const id = typeof msg.id === 'string' ? msg.id : null;
      const controller = id ? new AbortController() : null;
      if (id && controller) {
        cancellable.set(id, controller);
      }
      callBridge(msg, unsaved, controller?.signal)
        .then(sendResponse)
        .finally(() => {
          if (id) {
            cancellable.delete(id);
          }
        });
      return true;
    },
  );

  chrome.action.onClicked.addListener((tab) => {
    countNow('ext.toolbar.toggle');
    toggle(tab);
  });
  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === 'open-board') {
      countNow('ext.shortcut.openBoard');
      await openPage('board');
      return;
    }
    if (command !== 'toggle-panel') {
      return;
    }
    countNow('ext.shortcut.togglePanel');
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
