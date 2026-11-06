/**
 * The address the board opens on. With a reverse proxy (puma-dev) the bridge can be reached as
 * https://once-upon.test, where the page keeps its key in a cookie; without one, only as http://127.0.0.1:<port>. A
 * public_host named in config.json is always used. The default name is used only when it resolves to this machine, so a
 * setup with no proxy (a new user's) gets the 127.0.0.1 address instead of a link that goes nowhere. Answers are kept a
 * minute.
 */
import { addressesOf } from '@once-upon-a-diff/adapters/os';
import { readSettings } from '@once-upon-a-diff/foundation/settings';

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const KEPT_MS = 60 * 1000;
const kept = new Map<string, { at: number; ok: boolean }>();

/** Whether the name resolves to this machine, within a second. ONCE_UPON_NO_HOST_CHECK=1 (the tests') skips the lookup. */
export async function resolvesHere(host: string): Promise<boolean> {
  if (process.env.ONCE_UPON_NO_HOST_CHECK === '1') {
    return true;
  }
  const known = kept.get(host);
  if (known && Date.now() - known.at < KEPT_MS) {
    return known.ok;
  }
  let ok = false;
  try {
    const found = await Promise.race([
      addressesOf(host),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('slow')), 1000).unref(),
      ),
    ]);
    ok = found.some((address) => LOOPBACK.has(address));
  } catch {
    ok = false;
  }
  kept.set(host, { at: Date.now(), ok });
  return ok;
}

/** The proxy's address (https on the public host) when config.json names one and it reaches this machine, else undefined. */
export async function publicOriginOf(home: string): Promise<string | undefined> {
  const { publicHost: host, publicHostSet } = readSettings(home);
  return host && (publicHostSet || (await resolvesHere(host))) ? `https://${host}` : undefined;
}
