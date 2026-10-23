import { DEFAULT_PORT } from '@once-upon-a-diff/shared/util/bridge-port';

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
