/*
 * The pieces of a request the routes share: the error that carries an HTTP
 * status, the token check, the JSON body (256 KB at most), and clipping the
 * values the panel sends before they're stored.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ErrorCode } from '@once-upon-a-diff/domain/error-code';
import type { Body } from './types.ts';

const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  declare status: number;
  /** what the answer's `code` is when it isn't the status's own (codeOfStatus): `no_route` for a path with no route */
  declare code: ErrorCode | undefined;
  constructor(status: number, message: string, code?: ErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Constant-time comparison of the given token with the bridge's. */
export function sameToken(given: unknown, token: string): boolean {
  const givenBytes = Buffer.from(String(given || ''));
  const tokenBytes = Buffer.from(String(token));
  return givenBytes.length === tokenBytes.length && timingSafeEqual(givenBytes, tokenBytes);
}

/** The request's JSON body ({} when empty). Rejects with 413 past 256 KB, 400 when it isn't a JSON object. */
export function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // past the limit: stop keeping it and let the rest drain, so the 413 gets out (the server then closes)
    const tooLarge = () => {
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.resume();
      reject(new HttpError(413, 'body too large'));
    };
    if (Number(req.headers['content-length']) > MAX_BODY) {
      tooLarge();
      return;
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        return resolve({});
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'body is not JSON'));
        return;
      }
      // a handler reads fields off it, so null, a number or a list would only be a 500 later
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new HttpError(400, 'body must be a JSON object'));
        return;
      }
      resolve(parsed as Body);
    });
    req.on('error', reject);
  });
}

/** A string at most `max` long, or null for null and undefined. */
export function clipText(value: unknown, max = 4000): string | null {
  if (typeof value === 'string') {
    return value.slice(0, max);
  }
  return value == null ? null : String(value).slice(0, max);
}

/** A whole number, or null when it isn't one. */
export const toInt = (value: unknown): number | null =>
  Number.isFinite(+(value as number)) ? Math.trunc(+(value as number)) : null;
