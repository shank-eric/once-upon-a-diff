/*
 * What the content scripts keep in the browser: the panel's state per PR and
 * a copy of the Hide whitespace setting in chrome.storage.local, and small
 * per-tab values in sessionStorage. Every call survives the extension being
 * reloaded under the page (it reads as empty, and writes are dropped).
 */
import { extensionAlive } from './bridge.ts';
import type { InitialUi } from '@once-upon-a-diff/shared/overlay';

/** The panel's saved state for a PR, and whether it was hidden. */
export type PanelUi = InitialUi;

/** The chrome.storage copy of prefs.json's Hide whitespace; dirty: changed while the bridge was down. */
export interface PrefsCopy {
  hideWhitespace?: boolean;
  dirty?: boolean;
}

const panelUiKey = (prKey: string) => `ui:${prKey}`;

/** The panel's saved state for this PR: {n, all, collapsed, width, hidden, ...}, or {}. */
export async function loadPanelUi(prKey: string): Promise<PanelUi> {
  if (!extensionAlive()) {
    return {};
  }
  try {
    return (
      ((await chrome.storage.local.get(panelUiKey(prKey)))[panelUiKey(prKey)] as PanelUi) || {}
    );
  } catch {
    return {};
  }
}

export async function savePanelUi(prKey: string, panelUi: PanelUi): Promise<void> {
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
export async function loadPrefsCopy(): Promise<PrefsCopy | null> {
  if (!extensionAlive()) {
    return null;
  }
  try {
    return ((await chrome.storage.local.get('prefs')).prefs as PrefsCopy) || null;
  } catch {
    return null;
  }
}

export async function storePrefsCopy(value: PrefsCopy): Promise<void> {
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
  get: (key: string): unknown => {
    try {
      return JSON.parse(sessionStorage.getItem(key) as string); // JSON.parse(null) is null
    } catch {
      return null;
    }
  },
  set: (key: string, value: unknown): void => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage blocked */
    }
  },
};
