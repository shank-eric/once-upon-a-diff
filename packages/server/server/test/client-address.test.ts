import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { forwardedAddresses, isLoopbackAddress, nonLoopbackClient } from '../src/client-address.ts';

test('isLoopbackAddress: 127/8, ::1 and their mapped forms; everything else, a name or garbage is not', () => {
  for (const ok of [
    '127.0.0.1',
    '127.1.2.3',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '[::1]:8080',
    '127.0.0.1:80',
    ' 127.0.0.1 ',
  ]) {
    assert.equal(isLoopbackAddress(ok), true, ok);
  }
  for (const other of [
    '',
    'localhost',
    'unknown',
    '_hidden',
    '10.0.0.1',
    '192.168.1.50',
    '128.0.0.1',
    '127.0.0',
    '127.0.0.1.5',
    '127.0.0.256',
    '::ffff:10.0.0.1',
    '::',
    '::2',
    'fe80::1%en0',
    '2001:db8::1',
    'garbage',
    // the hex mapped form of 127.0.0.1 is refused on purpose: no proxy writes it
    '::ffff:7f00:1',
  ]) {
    assert.equal(isLoopbackAddress(other), false, other);
  }
});

test('forwardedAddresses: every entry of X-Forwarded-For, X-Real-IP and each for= of Forwarded, quotes and brackets stripped', () => {
  assert.deepEqual(forwardedAddresses({}), []);
  assert.deepEqual(forwardedAddresses({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), [
    '1.1.1.1',
    '2.2.2.2',
  ]);
  assert.deepEqual(forwardedAddresses({ 'x-forwarded-for': ['1.1.1.1', '2.2.2.2,3.3.3.3'] }), [
    '1.1.1.1',
    '2.2.2.2',
    '3.3.3.3',
  ]);
  assert.deepEqual(forwardedAddresses({ 'x-real-ip': '10.0.0.2' }), ['10.0.0.2']);
  assert.deepEqual(
    forwardedAddresses({
      forwarded: 'for=1.1.1.1;proto=https, For="[::1]:4711";by=x, for=_hidden',
    }),
    ['1.1.1.1', '[::1]:4711', '_hidden'],
  );
  // a header that is there but names no address still counts, as an empty entry
  assert.deepEqual(forwardedAddresses({ 'x-forwarded-for': '' }), ['']);
  assert.deepEqual(forwardedAddresses({ forwarded: 'proto=https' }), ['']);
});

const fake = (remoteAddress: string | undefined, headers: Record<string, string> = {}) =>
  ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

test('nonLoopbackClient: the peer and every forwarded address must be loopback; a missing peer refuses', () => {
  assert.equal(nonLoopbackClient(fake('127.0.0.1')), false);
  assert.equal(nonLoopbackClient(fake('::1')), false);
  assert.equal(nonLoopbackClient(fake('::ffff:127.0.0.1')), false);
  assert.equal(nonLoopbackClient(fake('127.0.0.1', { 'x-forwarded-for': '::1' })), false);
  // the peer branch: a real test connection is always loopback, so a stub stands in for a LAN peer
  assert.equal(nonLoopbackClient(fake('192.168.1.5')), true);
  assert.equal(nonLoopbackClient(fake('::ffff:192.168.1.5')), true);
  assert.equal(nonLoopbackClient(fake(undefined)), true);
  assert.equal(nonLoopbackClient(fake('127.0.0.1', { 'x-forwarded-for': '192.168.1.5' })), true);
  assert.equal(nonLoopbackClient(fake('127.0.0.1', { forwarded: 'for=unknown' })), true);
});
