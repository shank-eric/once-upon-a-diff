// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * The pieces of a request the routes share: the error that carries an HTTP
 * status, the token check, the JSON body (256 KB at most), and clipping the
 * values the panel sends before they're stored.
 */
import { timingSafeEqual } from 'node:crypto';

const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Constant-time comparison of the given token with the bridge's. */
export function sameToken(given, token) {
  const givenBytes = Buffer.from(String(given || ''));
  const tokenBytes = Buffer.from(String(token));
  return givenBytes.length === tokenBytes.length && timingSafeEqual(givenBytes, tokenBytes);
}

/** The request's JSON body ({} when empty). Rejects with 413 past 256 KB, 400 when it isn't JSON. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** A string at most `max` long, or null for null and undefined. */
export function clipText(value, max = 4000) {
  if (typeof value === 'string') {
    return value.slice(0, max);
  }
  return value == null ? null : String(value).slice(0, max);
}

/** A whole number, or null when it isn't one. */
export const toInt = (value) => (Number.isFinite(+value) ? Math.trunc(+value) : null);
