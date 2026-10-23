// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * The content scripts' one way out: a message to the service worker
 * (background.js), which calls the bridge on 127.0.0.1. GitHub's page never
 * talks to the bridge itself.
 */

/** false once the extension has been reloaded or removed under this page: chrome.* calls would throw. */
export const extensionAlive = () => !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

/**
 * Calls the bridge through the service worker.
 * Resolves to {ok, status, body, error}; it never rejects, and status is 0 when the call didn't get there.
 */
export async function callBridge(method, path, body) {
  if (!extensionAlive()) {
    return { ok: false, status: 0, error: 'extension reloaded' };
  }
  try {
    const answer = await chrome.runtime.sendMessage({ type: 'bridge', method, path, body });
    return answer || { ok: false, status: 0, error: 'no answer' };
  } catch {
    return { ok: false, status: 0, error: 'extension reloaded' };
  }
}
