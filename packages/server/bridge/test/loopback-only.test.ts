import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startBridge, tmp, TOKEN } from './helpers.ts';
import type { TestBridge } from './helpers.ts';

// The bridge answers this machine only: a proxy on the Mac forwards LAN clients with their address in a forwarding
// header, and a request that names any address that is not loopback is refused (403 forbidden), whatever its Host.

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

/** A request with the Host and forwarding headers the test chooses (fetch won't let a script set Host). */
function rawRequest(
  base: string,
  route: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, method: 'GET', path: route, headers },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode as number, text }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const NAME = 'once-upon.test';
const viaProxy = (headers: Record<string, string>) => ({ Host: NAME, ...headers });
const AUTH = { Authorization: `Bearer ${TOKEN}` };

async function bridgeUp() {
  const bridge = await startBridge({ home: tmp('loopback-only-home') });
  open.push(bridge);
  return bridge;
}

test('a client address that is not loopback, in any forwarding header, is refused with 403 forbidden', async () => {
  const { base } = await bridgeUp();
  const refused = async (route: string, headers: Record<string, string>) => {
    const answer = await rawRequest(base, route, viaProxy({ ...AUTH, ...headers }));
    assert.equal(answer.status, 403, `${route} ${JSON.stringify(headers)}`);
    assert.equal(JSON.parse(answer.text).code, 'forbidden');
  };
  await refused('/api/health', { 'X-Forwarded-For': '192.168.1.50' });
  await refused('/board/', { 'X-Forwarded-For': '192.168.1.50' });
  await refused('/local/x/', { 'X-Forwarded-For': '192.168.1.50' });
  // a forged first entry does not hide the real client, and one bad entry anywhere refuses
  await refused('/board/', { 'X-Forwarded-For': '127.0.0.1, 192.168.1.50' });
  await refused('/board/', { 'X-Forwarded-For': '192.168.1.50, 127.0.0.1' });
  await refused('/board/', { 'X-Forwarded-For': '127.0.0.1,::1,10.0.0.9' });
  await refused('/board/', { Forwarded: 'for=203.0.113.9' });
  await refused('/board/', { Forwarded: 'for=127.0.0.1;proto=https, for="[2001:db8::1]:4711"' });
  await refused('/board/', { 'X-Real-IP': '10.0.0.2' });
  await refused('/board/', { 'X-Forwarded-For': 'unknown' });
  await refused('/board/', { 'X-Forwarded-For': '::ffff:10.0.0.1' });
  await refused('/board/', { 'X-Forwarded-For': '2001:db8::1' });
  await refused('/board/', { 'X-Forwarded-For': 'fe80::1%en0' });
  await refused('/board/', { 'X-Forwarded-For': '' });
  // the Host check still comes first
  assert.equal(
    (await rawRequest(base, '/board/', { Host: 'evil.test', 'X-Forwarded-For': '10.0.0.1' }))
      .status,
    421,
  );
  // and the refusal comes before the Origin check
  assert.equal(
    (
      await rawRequest(
        base,
        '/board/',
        viaProxy({ 'X-Forwarded-For': '10.0.0.1', Origin: 'https://evil.test' }),
      )
    ).status,
    403,
  );
});

test('this machine’s own clients still get in: direct, or through a proxy that names a loopback address', async () => {
  const { base, call } = await bridgeUp();
  // the extension and the local pages: the bridge's own address, no forwarding headers
  assert.equal((await call('GET', '/api/health')).status, 200);
  assert.equal((await rawRequest(base, '/board/', {})).status, 200);
  // the board through the proxy from this Mac's own browser
  for (const client of [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '127.0.0.1, ::1',
    '[::1]:51234',
    '127.0.0.1:51234',
  ]) {
    const answer = await rawRequest(base, '/board/', viaProxy({ 'X-Forwarded-For': client }));
    assert.equal(answer.status, 200, client);
  }
  assert.equal(
    (await rawRequest(base, '/board/', viaProxy({ Forwarded: 'for="[::1]:4711";proto=https' })))
      .status,
    200,
  );
  assert.equal(
    (await rawRequest(base, '/board/', viaProxy({ 'X-Real-IP': '127.0.0.1' }))).status,
    200,
  );
});
