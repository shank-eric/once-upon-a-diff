import { DEFAULT_PORT } from '@once-upon-a-diff/terms/bridge-port';

/** Where the bridge is, and the token it wants. */
export interface BridgeSettings {
  port: number;
  token: string;
}

/** {port, token} for the bridge, from chrome.storage.local. */
export async function getSettings(): Promise<BridgeSettings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { port: DEFAULT_PORT, token: '', ...((settings || {}) as Partial<BridgeSettings>) };
}

export async function setSettings(next: BridgeSettings): Promise<void> {
  await chrome.storage.local.set({ settings: next });
}

/**
 * Closes chrome.storage.local to content scripts (they run on github.com), so only the worker and the extension's own pages
 * read the token. Called on every start of the worker and the options page. Needs Chrome 102+; a browser without it keeps
 * the old behavior (the token stays readable there), so a missing method is not an error.
 */
export async function lockStorage(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    /* an old browser, or one without the method (Firefox) */
  }
}
