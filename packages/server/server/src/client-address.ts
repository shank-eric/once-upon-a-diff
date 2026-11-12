import type { IncomingMessage, IncomingHttpHeaders } from 'node:http';

/**
 * Who is asking, as far as the bridge can tell. It binds 127.0.0.1, so a request's TCP peer is always this machine;
 * a proxy here (puma-dev) is what carries a LAN client in, and it says who that client was in a forwarding header.
 * The headers are read to refuse only: they can add a refusal, never an allowance, so a forged one gains nothing.
 */

/** 127.0.0.0/8, ::1, and ::ffff:127.x.x.x. Anything else, a name or garbage is false. A `[ ]`, a `:port` and a `%zone` are ignored. */
export function isLoopbackAddress(addr: string): boolean {
  let text = addr.trim();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(text);
  if (bracketed) {
    text = bracketed[1] as string;
  } else if (/^[^:]*:\d+$/.test(text)) {
    text = text.slice(0, text.lastIndexOf(':'));
  }
  text = text.replace(/%.*$/, '').toLowerCase();
  text = text.replace(/^::ffff:(?=\d+\.)/, '');
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (quad) {
    return quad.slice(1).every((part) => Number(part) <= 255) && quad[1] === '127';
  }
  // ::ffff:7f00:1 (hex mapped) is refused: no proxy writes it
  return /^(0{1,4}:){7}0{0,3}1$/.test(text) || text === '::1';
}

/**
 * Every address the forwarding headers name: each entry of X-Forwarded-For, X-Real-IP, and each for= of Forwarded
 * (quotes stripped). A header that is there but names nothing parseable counts as one empty entry, which is refused.
 */
export function forwardedAddresses(headers: IncomingHttpHeaders): string[] {
  const out: string[] = [];
  const values = (name: string): string[] => {
    const value = headers[name] ?? [];
    return Array.isArray(value) ? value : [value];
  };
  for (const value of [...values('x-forwarded-for'), ...values('x-real-ip')]) {
    out.push(...value.split(',').map((entry) => entry.trim()));
  }
  for (const value of values('forwarded')) {
    const found = value
      .split(',')
      .map((element) => /(?:^|;)\s*for\s*=\s*("[^"]*"|[^;,\s]*)/i.exec(element)?.[1])
      .filter((entry): entry is string => entry !== undefined)
      .map((entry) => entry.replace(/^"|"$/g, '').trim());
    out.push(...(found.length ? found : ['']));
  }
  return out;
}

/** True when the peer, or any address a forwarding header names, is not loopback. A missing peer address refuses. */
export function nonLoopbackClient(req: IncomingMessage): boolean {
  return (
    !isLoopbackAddress(req.socket.remoteAddress ?? '') ||
    forwardedAddresses(req.headers).some((addr) => !isLoopbackAddress(addr))
  );
}
