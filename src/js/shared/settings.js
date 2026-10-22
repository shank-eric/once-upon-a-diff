export const DEFAULT_PORT = 4823;

/** {port, token} for the bridge, from chrome.storage.local. */
export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { port: DEFAULT_PORT, token: '', .../** @type {object} */ (settings || {}) };
}

export async function setSettings(next) {
  await chrome.storage.local.set({ settings: next });
}
