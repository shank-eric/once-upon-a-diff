import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBridgeCaller } from '../src/bridge-call.ts';

const TOKEN = 'the-real-token-0123456789abcdef';
const PORT = 4823;

interface Seen {
  url: string;
  authorization: string | null;
  body: string | null;
}

/** A fake fetch for a listener on PORT: `proofOf(nonce, port)` is what it answers the handshake with (a function, or null for no handshake route). */
function listener(opts: {
  proofOf: ((nonce: string, port: number) => string) | null;
  api?: (count: number) => number;
}) {
  const seen: Seen[] = [];
  let apiCalls = 0;
  const fakeFetch = (async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : null;
    seen.push({ url: String(input), authorization: headers.get('Authorization'), body });
    if (String(input).endsWith('/auth/handshake')) {
      if (!opts.proofOf) {
        return new Response('{"error":"not found"}', { status: 404 });
      }
      const nonce = JSON.parse(body as string).nonce;
      return Response.json({ proof: opts.proofOf(nonce, PORT) });
    }
    apiCalls++;
    return Response.json({ up: 1 }, { status: opts.api ? opts.api(apiCalls) : 200 });
  }) as unknown as typeof fetch;
  return { seen, fakeFetch };
}

const realProof = (nonce: string, port: number) =>
  createHmac('sha256', TOKEN).update(`once-upon-handshake:${port}:${nonce}`).digest('hex');

const callerFor = (fakeFetch: typeof fetch) =>
  createBridgeCaller({
    fetch: fakeFetch,
    getSettings: async () => ({ port: PORT, token: TOKEN }),
    crypto: globalThis.crypto,
  });

const HEALTH = { type: 'bridge', path: '/api/health' } as const;

test('a listener that cannot prove it knows the token never sees it', async () => {
  const wrongs: Array<(nonce: string, port: number) => string> = [
    () => 'f'.repeat(64), // a guess
    () => 'not hex', // junk
    (nonce) =>
      createHmac('sha256', 'another-token')
        .update(`once-upon-handshake:${PORT}:${nonce}`)
        .digest('hex'),
    (nonce) => realProof(nonce, PORT + 1), // relayed from a bridge on another port
  ];
  for (const proofOf of wrongs) {
    const { seen, fakeFetch } = listener({ proofOf });
    const answer = await callerFor(fakeFetch)(HEALTH, null);
    assert.deepEqual(answer, { ok: false, status: 0, error: 'not-the-bridge' });
    assert.ok(
      seen.length > 0 && seen.every((one) => one.authorization === null),
      'no Authorization header',
    );
    assert.ok(seen.every((one) => !JSON.stringify(one).includes(TOKEN)));
  }
});

test('a bridge with no handshake route is too old, and gets no token either', async () => {
  const { seen, fakeFetch } = listener({ proofOf: null });
  const answer = await callerFor(fakeFetch)(HEALTH, null);
  assert.deepEqual(answer, { ok: false, status: 0, error: 'bridge-too-old' });
  assert.ok(seen.every((one) => one.authorization === null));
});

test('the real bridge gets the token, proved before each call with a fresh nonce', async () => {
  const { seen, fakeFetch } = listener({ proofOf: realProof });
  const call = callerFor(fakeFetch);
  assert.equal((await call(HEALTH, null)).ok, true);
  assert.equal((await call(HEALTH, null)).ok, true);
  assert.deepEqual(
    seen.map((one) => [one.url.replace(/^.*:4823/, ''), one.authorization]),
    [
      ['/auth/handshake', null],
      ['/api/health', `Bearer ${TOKEN}`],
      ['/auth/handshake', null],
      ['/api/health', `Bearer ${TOKEN}`],
    ],
  );
  assert.notEqual(
    JSON.parse(seen[0].body as string).nonce,
    JSON.parse(seen[2].body as string).nonce,
  );
});

test('a listener swapped in after a good call never gets the token', async () => {
  const good = listener({ proofOf: realProof });
  const impostor = listener({ proofOf: () => 'f'.repeat(64) });
  let swapped = false;
  const call = callerFor(((input: string, init?: RequestInit) =>
    (swapped ? impostor : good).fakeFetch(input, init)) as unknown as typeof fetch);
  assert.equal((await call(HEALTH, null)).ok, true);
  swapped = true;
  assert.deepEqual(await call(HEALTH, null), { ok: false, status: 0, error: 'not-the-bridge' });
  assert.ok(impostor.seen.length > 0 && impostor.seen.every((one) => one.authorization === null));
  assert.ok(impostor.seen.every((one) => !JSON.stringify(one).includes(TOKEN)));
});

test('a lost bridge answers unreachable, and a 401 passes through', async () => {
  const unauthorized = listener({ proofOf: realProof, api: () => 401 });
  assert.equal((await callerFor(unauthorized.fakeFetch)(HEALTH, null)).status, 401);

  let down = false;
  const live = listener({ proofOf: realProof }).fakeFetch;
  const gone = createBridgeCaller({
    fetch: (async (input: string, init?: RequestInit) => {
      if (down) {
        throw new Error('refused');
      }
      return live(input, init);
    }) as unknown as typeof fetch,
    getSettings: async () => ({ port: PORT, token: TOKEN }),
    crypto: globalThis.crypto,
  });
  assert.equal((await gone(HEALTH, null)).ok, true);
  down = true;
  assert.equal((await gone(HEALTH, null)).error, 'unreachable');
});

test('a token tried in the options page is proved with that token', async () => {
  const { seen, fakeFetch } = listener({ proofOf: realProof });
  const call = callerFor(fakeFetch);
  const answer = await call(HEALTH, { port: PORT, token: 'a-typo' });
  assert.equal(answer.error, 'not-the-bridge');
  assert.ok(seen.every((one) => one.authorization === null));
});

test('a refusal the listener words itself reaches the user, and still gets no token', async () => {
  for (const [status, error] of [
    [403, 'origin not allowed: add abc to extension_ids in ~/.once-upon/config.json'],
    [421, 'misdirected request'],
  ] as const) {
    const seen: Seen[] = [];
    const fakeFetch = (async (input: string, init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
        body: null,
      });
      return Response.json({ error }, { status });
    }) as unknown as typeof fetch;
    const answer = await callerFor(fakeFetch)(HEALTH, null);
    assert.deepEqual(answer, { ok: false, status: 0, error });
    assert.ok(seen.every((one) => one.authorization === null));
  }
  // a refusal with no JSON error is still taken for an impostor
  const plain = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
  assert.equal((await callerFor(plain)(HEALTH, null)).error, 'not-the-bridge');
});
