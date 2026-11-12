import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the page drops its key only once a call by cookie alone has worked', async () => {
  const saved = {
    fetch: globalThis.fetch,
    location: globalThis.location,
    history: globalThis.history,
  };
  const scenario = async (name: string, session: unknown, probeStatus: number) => {
    const replaced: string[] = [];
    const calls: string[] = [];
    Object.assign(globalThis, {
      location: { hash: '#key=page.abc&repo=acme%2Fwidgets', pathname: '/board/', search: '' },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url),
      },
      fetch: async (url: string) => {
        calls.push(url);
        return url === '/auth/session'
          ? Response.json(session)
          : new Response('{}', { status: probeStatus });
      },
    });
    // a fresh copy of the module each time, since it keeps whether the cookie is in use
    const auth = await import(new URL(`../public/local/auth.ts?${name}`, import.meta.url).href);
    await auth.startAuth('page.abc', '/api/board');
    return { header: auth.authHeader('page.abc'), replaced, calls };
  };
  try {
    const worked = await scenario('worked', { cookie: true }, 200);
    assert.deepEqual(worked.header, {}, 'the cookie carries it');
    assert.deepEqual(worked.replaced, ['/board/#repo=acme%2Fwidgets']);
    assert.deepEqual(worked.calls, ['/auth/session', '/api/board']);

    const refused = await scenario('refused', { cookie: true }, 401);
    assert.deepEqual(
      refused.header,
      { Authorization: 'Bearer page.abc' },
      'the browser kept no cookie',
    );
    assert.deepEqual(refused.replaced, [], 'so the key stays in the address bar');

    const none = await scenario('none', { cookie: false }, 200);
    assert.deepEqual(none.header, { Authorization: 'Bearer page.abc' });
    assert.deepEqual(none.replaced, []);
    assert.deepEqual(none.calls, ['/auth/session'], 'no cookie, nothing to check');
  } finally {
    Object.assign(globalThis, saved);
  }
});
