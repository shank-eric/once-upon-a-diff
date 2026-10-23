// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * What the content scripts keep in the browser: the panel's state per PR and
 * a copy of the Hide whitespace setting in chrome.storage.local, and small
 * per-tab values in sessionStorage. Every call survives the extension being
 * reloaded under the page (it reads as empty, and writes are dropped).
 */
import { extensionAlive } from './bridge.ts';

const panelUiKey = (prKey) => `ui:${prKey}`;

/** The panel's saved state for this PR: {n, all, collapsed, width, hidden, ...}, or {}. */
export async function loadPanelUi(prKey) {
  if (!extensionAlive()) {
    return {};
  }
  try {
    return (await chrome.storage.local.get(panelUiKey(prKey)))[panelUiKey(prKey)] || {};
  } catch {
    return {};
  }
}

export async function savePanelUi(prKey, panelUi) {
  if (!extensionAlive()) {
    return;
  }
  try {
    await chrome.storage.local.set({ [panelUiKey(prKey)]: panelUi });
  } catch {
    /* extension reloaded */
  }
}

/** The chrome.storage copy of the bridge's prefs.json, for when the bridge is down. */
export async function loadPrefsCopy() {
  if (!extensionAlive()) {
    return null;
  }
  try {
    return (await chrome.storage.local.get('prefs')).prefs || null;
  } catch {
    return null;
  }
}

export async function storePrefsCopy(value) {
  if (!extensionAlive()) {
    return;
  }
  try {
    await chrome.storage.local.set({ prefs: value });
  } catch {
    /* extension reloaded */
  }
}

/** JSON values in this tab's sessionStorage; null when it's blocked or holds nothing. */
export const tabSession = {
  get: (key) => {
    try {
      return JSON.parse(sessionStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage blocked */
    }
  },
};
