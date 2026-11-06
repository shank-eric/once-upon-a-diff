/*
 * The content scripts' one way out: a message to the service worker
 * (background.js), which calls the bridge on 127.0.0.1. GitHub's page never
 * talks to the bridge itself.
 */
import { createClient, type Reply, type Transport } from '@once-upon-a-diff/bridge-client/client';
import { createUsage } from '@once-upon-a-diff/bridge-client/usage';
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import type { BridgeSettings } from '../settings.ts';

export type BridgeMethod = 'GET' | 'POST';

/** What a page sends the service worker: settings only from the extension's own pages (the options page). */
export interface BridgeRequest {
  type: 'bridge';
  method?: BridgeMethod;
  path: string;
  body?: unknown;
  settings?: BridgeSettings;
  /** Set on a call with a signal (a poll's load): a later `bridge-abort` with the same id cancels its fetch in the service worker. */
  id?: string;
}

/** What a page sends the service worker when it no longer wants the answer to the call with this id. */
export interface BridgeAbort {
  type: 'bridge-abort';
  id: string;
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
 * bridge's own code makes it). This is the contracts client's Reply.
 */
export type BridgeAnswer<T = unknown> = Reply<T>;

/** false once the extension has been reloaded or removed under this page: chrome.* calls would throw. */
export const extensionAlive = () => !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

/**
 * Calls the bridge through the service worker.
 * Resolves to {ok, status, body, error}; it never rejects, and status is 0 when the call didn't get there.
 * With a `signal`, an abort resolves it at once ("aborted") and tells the service worker to abort its fetch too, so the
 * request to the bridge is closed and not only forgotten here. (If that message doesn't get there, the worker's fetch runs on.)
 */
export async function callBridge<T = unknown>(
  method: BridgeMethod,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<BridgeAnswer<T>> {
  if (!extensionAlive()) {
    return { ok: false, status: 0, error: 'extension reloaded' };
  }
  const aborted: BridgeAnswer<T> = { ok: false, status: 0, error: 'aborted' };
  if (signal?.aborted) {
    return aborted;
  }
  const id = signal ? crypto.randomUUID() : undefined;
  let onAbort: (() => void) | undefined;
  try {
    const sent: Promise<BridgeAnswer<T> | undefined> = chrome.runtime.sendMessage({
      type: 'bridge',
      method,
      path,
      body,
      ...(id ? { id } : {}),
    } satisfies BridgeRequest);
    const raced = signal
      ? Promise.race([
          sent,
          new Promise<BridgeAnswer<T>>((resolve) => {
            onAbort = () => {
              resolve(aborted);
              try {
                chrome.runtime
                  .sendMessage({ type: 'bridge-abort', id: id as string } satisfies BridgeAbort)
                  .catch(() => {});
              } catch {
                /* the extension was reloaded: its worker's fetch went with it */
              }
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }),
        ])
      : sent;
    const answer = await raced;
    return answer || { ok: false, status: 0, error: 'no answer' };
  } catch {
    return { ok: false, status: 0, error: 'extension reloaded' };
  } finally {
    if (onAbort) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** callBridge as the contracts client's transport. */
const transport: Transport = ({ method, path, body, signal }) =>
  callBridge(method, path, body, signal);

/**
 * The typed way to call the bridge from a content script: `bridge.call(ROUTES.name, {params, query, body})` answers
 * {ok, status, body, error} and never rejects, with the route's body and answer types (@once-upon-a-diff/contracts).
 */
export const bridge = createClient(transport);

/** Counts the content scripts' UI-only actions for the usage capture, sent to the bridge in batches (names and counts only). */
export const usage = createUsage(async (counts) => {
  const reply = await bridge.call(ROUTES.usageCount, { body: { counts } });
  return reply.ok ? reply.body : null;
});
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void usage.flush();
    }
  });
}

/** The client's type, for what takes one (a test passes its own). */
export type Bridge = typeof bridge;
