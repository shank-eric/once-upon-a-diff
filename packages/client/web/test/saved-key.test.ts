/** A page remembers its key: saved from the link and taken out of the address bar, used when the link has none, forgotten when refused. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './local-env.ts';

const KEY = 'page.fresh-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'page.saved-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * A browser that keeps what it is given, one address, and a bridge that takes only `accepts` as a key. A key it does not take
 * gets 401, which is what the real bridge answers for a page key that matches no story (bridge/test/page-key.test.ts pins it).
 */
function browser(hash: string, saved: Record<string, string>, accepts: string) {
  const store = new Map(Object.entries(saved));
  const replaced: string[] = [];
  const sent: (string | undefined)[] = [];
  Object.assign(globalThis, {
    location: {
      hash,
      href: `http://127.0.0.1:1/local/story-1/${hash}`,
      pathname: '/local/story-1/',
      search: '',
    },
    history: { replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) },
    localStorage: {
      getItem: (name: string) => store.get(name) ?? null,
      setItem: (name: string, value: string) => void store.set(name, value),
      removeItem: (name: string) => void store.delete(name),
    },
    fetch: async (_path: string, init: { headers?: Record<string, string> }) => {
      const auth = init.headers?.Authorization;
      sent.push(auth);
      const ok = auth === `Bearer ${accepts}`;
      return {
        ok,
        status: ok ? 200 : 401,
        json: async () => (ok ? { on: false } : { error: 'missing or wrong token' }),
      };
    },
  });
  return { store, replaced, sent };
}

/** A fresh copy of the page's module (it reads the address once, as it loads), and one call through its transport. */
async function openPage(name: string) {
  const { bridge } = await import(new URL(`../public/local/page.ts?${name}`, import.meta.url).href);
  const { ROUTES } = await import('/assets/contracts/routes.ts');
  return bridge.call(ROUTES.storyUsageCount, { params: { id: 'story-1' }, body: { counts: {} } });
}

test('a key in the link is saved and taken out of the address bar, keeping other fragment parts', async () => {
  const seen = browser(`#key=${KEY}&x=1`, {}, KEY);
  const reply = await openPage('link');
  assert.equal(reply.ok, true);
  assert.equal(seen.store.get('ou-key:story-1'), KEY);
  assert.deepEqual(seen.replaced, ['/local/story-1/#x=1']);
  assert.deepEqual(seen.sent, [`Bearer ${KEY}`]);
});

test("a link's key the bridge refuses is not saved, and a good saved key stays", async () => {
  const seen = browser(`#key=${KEY}&x=1`, { 'ou-key:story-1': OLD }, OLD);
  const reply = await openPage('refused-link');
  assert.equal(reply.ok, false);
  assert.equal(seen.store.get('ou-key:story-1'), OLD);
  assert.deepEqual(seen.replaced, [], 'the key stays in the address for another try');
});

test('a link with no key uses the saved one', async () => {
  const seen = browser('', { 'ou-key:story-1': OLD }, OLD);
  assert.equal((await openPage('saved')).ok, true);
  assert.deepEqual(seen.sent, [`Bearer ${OLD}`]);
  assert.deepEqual(seen.replaced, []);
});

test("a link's key wins over a saved one and replaces it", async () => {
  const seen = browser(`#key=${KEY}`, { 'ou-key:story-1': OLD }, KEY);
  await openPage('newer');
  assert.deepEqual(seen.sent, [`Bearer ${KEY}`]);
  assert.equal(seen.store.get('ou-key:story-1'), KEY);
});

test('a saved key the bridge refuses is forgotten, and the page says how to get a new one', async () => {
  const seen = browser('', { 'ou-key:story-1': OLD }, KEY);
  const reply = await openPage('stale');
  assert.equal(reply.ok, false);
  assert.equal(seen.store.has('ou-key:story-1'), false);
  assert.match(reply.error, /once-upon page --story story-1/);
});

test('no key anywhere: no call is made, and the page says to run the command', async () => {
  const seen = browser('', {}, KEY);
  const reply = await openPage('none');
  assert.equal(reply.ok, false);
  assert.deepEqual(seen.sent, []);
  assert.match(reply.error, /once-upon page --story story-1/);
});

test('a browser that keeps nothing leaves the address bar alone, so the key is not lost', async () => {
  const seen = browser(`#key=${KEY}`, {}, KEY);
  Object.assign(globalThis, {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  assert.equal((await openPage('nostore')).ok, true);
  assert.deepEqual(seen.replaced, []);
});

test('the board saves its key where the host takes no cookie, and uses it on a keyless visit', async () => {
  const run = async (
    name: string,
    hash: string,
    saved: Record<string, string>,
    session: unknown,
  ) => {
    const store = new Map(Object.entries(saved));
    const replaced: string[] = [];
    Object.assign(globalThis, {
      location: { hash, pathname: '/board/', search: '' },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url),
      },
      localStorage: {
        getItem: (name: string) => store.get(name) ?? null,
        setItem: (name: string, value: string) => void store.set(name, value),
        removeItem: (name: string) => void store.delete(name),
      },
      fetch: async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url === '/auth/session') {
          return Response.json(session);
        }
        const auth = init?.headers?.Authorization;
        // the bridge takes the fresh key and the saved one, and refuses any other
        const ok = !auth || auth === `Bearer ${KEY}` || auth === `Bearer ${OLD}`;
        return new Response('{}', { status: ok ? 200 : 401 });
      },
    });
    const auth = await import(new URL(`../public/local/auth.ts?${name}`, import.meta.url).href);
    await auth.startAuth(new URLSearchParams(hash.slice(1)).get('key') || '', '/api/board');
    return { auth, store, replaced };
  };
  const plain = await run('plain', `#key=${KEY}&repo=a%2Fb`, {}, { cookie: false });
  assert.deepEqual(plain.auth.authHeader(), { Authorization: `Bearer ${KEY}` });
  assert.equal(plain.store.get('ou-key:board'), KEY);
  assert.deepEqual(plain.replaced, ['/board/#repo=a%2Fb']);

  const cookie = await run('cookie', `#key=${KEY}`, {}, { cookie: true });
  assert.deepEqual(cookie.auth.authHeader(), {}, 'the cookie carries it');
  assert.equal(cookie.store.has('ou-key:board'), false, 'and nothing else keeps the key');

  const later = await run('later', '', { 'ou-key:board': OLD }, { cookie: false });
  assert.deepEqual(
    later.auth.authHeader(),
    { Authorization: `Bearer ${OLD}` },
    'the saved key goes as a header',
  );
  later.auth.keyRefused();
  assert.equal(later.store.has('ou-key:board'), false);
  assert.deepEqual(later.auth.authHeader(), {});

  const none = await run('none', '', {}, { cookie: false });
  assert.deepEqual(none.auth.authHeader(), {});

  const stale = await run(
    'stale-link',
    '#key=page.nope-cccccccccccccccc',
    { 'ou-key:board': OLD },
    { cookie: false },
  );
  assert.equal(
    stale.store.get('ou-key:board'),
    OLD,
    'a refused link key does not replace the saved one',
  );
  assert.deepEqual(stale.replaced, []);
});
