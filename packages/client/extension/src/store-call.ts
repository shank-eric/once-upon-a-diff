/*
 * What the content scripts keep in chrome.storage.local, now that the token lives there and the area is closed to them
 * (settings.ts `lockStorage`): they send the service worker {type: 'store', op, key, value} and it reads or writes for them.
 * Only the keys the content scripts own: never `settings`.
 */

/** The refresh intents' key (content/refresh.ts). */
export const REFRESH_KEY = 'ou-refresh-pending';

/** The panel's state per PR (`ui:<pr>`), the Hide whitespace copy (`prefs`) and the refresh intents. */
export const isStoreKey = (key: unknown): key is string =>
  typeof key === 'string' && (/^ui:.+/.test(key) || key === 'prefs' || key === REFRESH_KEY);

export interface StoreRequest {
  type: 'store';
  op: 'get' | 'set';
  key: string;
  value?: unknown;
}

export interface StoreReply {
  ok: boolean;
  value?: unknown;
}

/** The part of chrome.storage.local this uses. */
export interface StoreArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Answers one store message from `area` (chrome.storage.local, or a stand-in). */
export async function storeCall(msg: StoreRequest, area: StoreArea): Promise<StoreReply> {
  if (!isStoreKey(msg.key)) {
    return { ok: false };
  }
  if (msg.op === 'get') {
    return { ok: true, value: (await area.get(msg.key))[msg.key] };
  }
  if (msg.op === 'set') {
    await area.set({ [msg.key]: msg.value });
    return { ok: true };
  }
  return { ok: false };
}
