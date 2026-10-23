// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide,
  filesPage,
  wOf,
  withW,
  seen,
  prefsStore,
  REDIRECT_GUARD_MS,
} from '../src/content/pages/hide-whitespace.ts';
import { tmp, startBridge } from 'once-upon-a-diff/test/helpers';

const PR_URL = 'https://github.com/acme/widgets/pull/7/changes';

describe('GitHub Hide whitespace: reading the URL', () => {
  test('knows a PR files page, and what w says', () => {
    assert.deepEqual(filesPage(`${PR_URL}?w=1#diff-abc`), {
      key: 'acme/widgets#7',
      view: 'changes',
    });
    assert.deepEqual(filesPage('https://github.com/Acme/Widgets/pull/7/files'), {
      key: 'acme/widgets#7',
      view: 'files',
    });
    assert.equal(filesPage('https://github.com/acme/widgets/pull/7'), null);
    assert.equal(wOf(PR_URL), null);
    assert.equal(wOf(`${PR_URL}?w=1`), true);
    assert.equal(wOf(`${PR_URL}?w=0`), false);
  });
  test('adds w=1 and keeps the rest of the URL, hash included', () => {
    assert.equal(withW(`${PR_URL}?diff=split#diff-abc`, true), `${PR_URL}?diff=split&w=1#diff-abc`);
    assert.equal(withW(`${PR_URL}?w=1&diff=split`, false), `${PR_URL}?diff=split`);
  });
});

describe('GitHub Hide whitespace: what to do', () => {
  const now = 1_000_000;
  test('with the setting on, a fresh arrival reloads once with ?w=1', () => {
    assert.deepEqual(
      decide({ href: `${PR_URL}#diff-abc`, prev: null, pref: true, redirect: null, now: now }),
      { action: 'redirect', url: `${PR_URL}?w=1#diff-abc` },
    );
    const fromConversation = seen('https://github.com/acme/widgets/pull/7');
    assert.equal(
      decide({ href: PR_URL, prev: fromConversation, pref: true, redirect: null, now: now }).action,
      'redirect',
    );
  });
  test('with the setting off, or already on w=1, nothing happens', () => {
    assert.deepEqual(decide({ href: PR_URL, prev: null, pref: false, redirect: null, now: now }), {
      action: 'none',
    });
    assert.deepEqual(
      decide({
        href: `${PR_URL}?w=1`,
        prev: seen(PR_URL),
        pref: true,
        redirect: { from: PR_URL, at: now },
        now: now + 500,
      }),
      { action: 'none' },
    );
    assert.deepEqual(
      decide({
        href: 'https://github.com/acme/widgets/pull/7',
        prev: null,
        pref: true,
        redirect: null,
        now: now,
      }),
      { action: 'none' },
    );
  });
  test("GitHub's own toggle becomes the setting", () => {
    assert.deepEqual(
      decide({ href: `${PR_URL}?w=1`, prev: seen(PR_URL), pref: false, redirect: null, now: now }),
      { action: 'save', value: true },
    );
    assert.deepEqual(
      decide({
        href: `${PR_URL}?w=0`,
        prev: seen(`${PR_URL}?w=1`),
        pref: true,
        redirect: null,
        now: now,
      }),
      { action: 'save', value: false },
    );
    // turning it off can just drop w from the same page
    assert.deepEqual(
      decide({ href: PR_URL, prev: seen(`${PR_URL}?w=1`), pref: true, redirect: null, now: now }),
      { action: 'save', value: false },
    );
    assert.deepEqual(
      decide({ href: PR_URL, prev: seen(`${PR_URL}?w=1`), pref: false, redirect: null, now: now }),
      { action: 'none' },
    );
  });
  test('w=1 on a different page or view is not a toggle off', () => {
    const other = seen('https://github.com/acme/widgets/pull/8/changes?w=1');
    assert.equal(
      decide({ href: PR_URL, prev: other, pref: true, redirect: null, now: now }).action,
      'redirect',
    );
    const files = seen('https://github.com/acme/widgets/pull/7/files?w=1');
    assert.equal(
      decide({ href: PR_URL, prev: files, pref: true, redirect: null, now: now }).action,
      'redirect',
    );
  });
  test("doesn't loop when GitHub drops the w=1 it was sent", () => {
    const redirect = { from: PR_URL, at: now };
    assert.deepEqual(
      decide({ href: PR_URL, prev: seen(PR_URL), pref: true, redirect, now: now + 2000 }),
      {
        action: 'none',
      },
    );
    // much later, the same URL may be redirected again
    assert.equal(
      decide({
        href: PR_URL,
        prev: seen(PR_URL),
        pref: true,
        redirect,
        now: now + REDIRECT_GUARD_MS + 1,
      }).action,
      'redirect',
    );
  });
});

describe('GitHub Hide whitespace: the saved setting', () => {
  const fakeStorage = (initial = null) => {
    const box = { v: initial };
    return {
      box,
      load: async () => box.v,
      store: async (value) => {
        box.v = value;
      },
    };
  };
  const down = async () => ({ ok: false, status: 0, error: 'unreachable' });

  test('is the same prefs.json setting the local page uses', async () => {
    const home = tmp('home');
    const bridge = await startBridge({ home });
    try {
      const call = async (method, path, body) => {
        const response = await bridge.call(method, path, body);
        return { ok: response.status === 200, body: response.body };
      };
      const storage = fakeStorage();
      const prefs = prefsStore({ call, ...storage });
      assert.equal(await prefs.read(), false);
      assert.equal(await prefs.write(true), true);
      assert.deepEqual((await bridge.call('GET', '/api/prefs')).body, {
        hideWhitespace: true,
        diffView: 'unified',
      });
      assert.deepEqual(storage.box.v, { hideWhitespace: true });
    } finally {
      await bridge.close();
    }
  });

  test('falls back to chrome.storage when the bridge is down, and sends the change when it is back', async () => {
    const storage = fakeStorage({ hideWhitespace: false });
    const offline = prefsStore({ call: down, ...storage });
    assert.equal(await offline.write(true), false);
    assert.deepEqual(storage.box.v, { hideWhitespace: true, dirty: true });
    assert.equal(await offline.read(), true);

    const sent = [];
    let saved = false;
    const call = async (method, path, body) => {
      if (method === 'POST') {
        sent.push(body);
        saved = body.hideWhitespace;
        return { ok: true, body: { hideWhitespace: saved } };
      }
      return { ok: true, body: { hideWhitespace: saved } };
    };
    const online = prefsStore({ call, ...storage });
    assert.equal(await online.read(), true);
    assert.deepEqual(sent, [{ hideWhitespace: true }]);
    assert.deepEqual(storage.box.v, { hideWhitespace: true }, 'no longer dirty');
  });

  test('takes the bridge value over a clean copy', async () => {
    const storage = fakeStorage({ hideWhitespace: true });
    const prefs = prefsStore({
      call: async () => ({ ok: true, body: { hideWhitespace: false } }),
      ...storage,
    });
    assert.equal(await prefs.read(), false);
    assert.deepEqual(storage.box.v, { hideWhitespace: false });
  });
});
