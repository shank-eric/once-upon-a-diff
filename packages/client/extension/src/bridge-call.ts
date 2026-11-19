/*
 * The service worker's one call to the bridge on http://127.0.0.1:<port>, and the check that comes before the token goes
 * out: the bridge must prove it knows the token (POST /auth/handshake), so a program that took the port while the bridge
 * was down never sees it. The worker (entrypoints/background.ts) is the only caller.
 */
import { matchRoute } from '@once-upon-a-diff/bridge-client/client';
import { EXTENSION_ROUTES } from './bridge-routes.ts';
import type { BridgeSettings } from './settings.ts';
import type { BridgeReply, BridgeRequest } from './content/bridge.ts';

const METHODS = new Set(['GET', 'POST']);
const enc = new TextEncoder();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** What the caller supplies, so a test can stand in the network, the stored settings and the crypto. */
export interface BridgeCallDeps {
  fetch: typeof fetch;
  getSettings: () => Promise<BridgeSettings>;
  crypto: Crypto;
}

/**
 * `callBridge` bound to its deps. Every call that carries the token is preceded by its own proof, never a remembered one:
 * the bridge may have restarted since the last call, and something else may hold the port now.
 */
export function createBridgeCaller({ fetch, getSettings, crypto }: BridgeCallDeps) {
  /** null when the listener on `port` proved it knows `token`, else the error to answer with. */
  async function prove(port: number, token: string, signal?: AbortSignal): Promise<string | null> {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const res = await fetch(`http://127.0.0.1:${port}/auth/handshake`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });
    if (res.status === 404) {
      return 'bridge-too-old'; // a bridge from before the handshake has no such route
    }
    let proof: unknown = null;
    try {
      const body = (await res.json()) as { proof?: unknown; error?: unknown };
      if (res.ok) {
        proof = body.proof;
      } else if (typeof body.error === 'string' && body.error) {
        // a refusal the bridge words itself (a 403 for an origin not in extension_ids, a 421): no token went out, so show it
        return body.error;
      }
    } catch {
      proof = null;
    }
    if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) {
      return 'not-the-bridge';
    }
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(token),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const given = Uint8Array.from(proof.match(/../g) as string[], (pair) => parseInt(pair, 16));
    // subtle.verify compares in constant time
    const same = await crypto.subtle.verify(
      'HMAC',
      key,
      given,
      enc.encode(`once-upon-handshake:${port}:${nonce}`),
    );
    return same ? null : 'not-the-bridge';
  }

  return async function callBridge(
    { method = 'GET', path, body }: BridgeRequest,
    override: BridgeSettings | null,
    signal?: AbortSignal,
  ): Promise<BridgeReply> {
    // only a call to one of the routes the extension makes (bridge-routes.ts), with its method: the token goes with nothing else
    if (
      !METHODS.has(method) ||
      typeof path !== 'string' ||
      !matchRoute(method, path, EXTENSION_ROUTES)
    ) {
      return { ok: false, status: 0, error: 'bad request' };
    }
    // the options page can test the values in its form before they're saved
    const { port: given, token } = override || (await getSettings());
    const port = Number(given);
    if (!token) {
      return { ok: false, status: 0, error: 'not-configured' };
    }
    try {
      const refused = await prove(port, token, signal);
      if (refused) {
        return { ok: false, status: 0, error: refused };
      }
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        cache: 'no-store',
        credentials: 'omit',
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: { error?: string } | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return {
        ok: res.ok,
        status: res.status,
        body: json,
        error: res.ok ? null : (json && json.error) || `HTTP ${res.status}`,
      };
    } catch {
      return { ok: false, status: 0, error: 'unreachable' };
    }
  };
}
