/*
 * The content scripts' one way out: a message to the service worker
 * (background.js), which calls the bridge on 127.0.0.1. GitHub's page never
 * talks to the bridge itself.
 */
import type { BridgeSettings } from '../settings.ts';

export type BridgeMethod = 'GET' | 'POST';

/** What a page sends the service worker: settings only from the extension's own pages (the options page). */
export interface BridgeRequest {
  type: 'bridge';
  method?: BridgeMethod;
  path: string;
  body?: unknown;
  settings?: BridgeSettings;
}

/** What the service worker sends back: status 0 when the call didn't get there, body the bridge's JSON. */
export interface BridgeReply {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string | null;
}

/**
 * The same, as a caller takes it: an ok answer's body is the bridge's JSON, of the type the caller asks for (the
 * bridge's own code makes it).
 */
export type BridgeAnswer<T = unknown> =
  | { ok: true; status: number; body: T; error?: null }
  | { ok: false; status: number; body?: unknown; error?: string | null };

/** false once the extension has been reloaded or removed under this page: chrome.* calls would throw. */
export const extensionAlive = () => !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

/**
 * Calls the bridge through the service worker.
 * Resolves to {ok, status, body, error}; it never rejects, and status is 0 when the call didn't get there.
 */
export async function callBridge<T = unknown>(
  method: BridgeMethod,
  path: string,
  body?: unknown,
): Promise<BridgeAnswer<T>> {
  if (!extensionAlive()) {
    return { ok: false, status: 0, error: 'extension reloaded' };
  }
  try {
    const answer: BridgeAnswer<T> | undefined = await chrome.runtime.sendMessage({
      type: 'bridge',
      method,
      path,
      body,
    } satisfies BridgeRequest);
    return answer || { ok: false, status: 0, error: 'no answer' };
  } catch {
    return { ok: false, status: 0, error: 'extension reloaded' };
  }
}
