import { DEFAULT_PORT } from '@once-upon-a-diff/shared/util/bridge-port';

/** {port, token} for the bridge, from chrome.storage.local. */
export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { port: DEFAULT_PORT, token: '', .../** @type {object} */ (settings || {}) };
}

export async function setSettings(next) {
  await chrome.storage.local.set({ settings: next });
}
