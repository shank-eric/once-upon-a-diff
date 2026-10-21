import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, filesPage, wOf, withW, seen, prefsStore, REDIRECT_GUARD_MS } from '../src/js/content/whitespace.js';
import { tmp, startBridge } from './helpers.mjs';

const PR = 'https://github.com/acme/widgets/pull/7/changes';

describe('GitHub Hide whitespace: reading the URL', () => {
  test('knows a PR files page, and what w says', () => {
    assert.deepEqual(filesPage(`${PR}?w=1#diff-abc`), { key: 'acme/widgets#7', view: 'changes' });
    assert.deepEqual(filesPage('https://github.com/Acme/Widgets/pull/7/files'), { key: 'acme/widgets#7', view: 'files' });
    assert.equal(filesPage('https://github.com/acme/widgets/pull/7'), null);
    assert.equal(wOf(PR), null);
    assert.equal(wOf(`${PR}?w=1`), true);
    assert.equal(wOf(`${PR}?w=0`), false);
  });
  test('adds w=1 and keeps the rest of the URL, hash included', () => {
    assert.equal(withW(`${PR}?diff=split#diff-abc`, true), `${PR}?diff=split&w=1#diff-abc`);
    assert.equal(withW(`${PR}?w=1&diff=split`, false), `${PR}?diff=split`);
  });
});

describe('GitHub Hide whitespace: what to do', () => {
  const at = 1_000_000;
  test('with the setting on, a fresh arrival reloads once with ?w=1', () => {
    assert.deepEqual(decide({ href: `${PR}#diff-abc`, prev: null, pref: true, redirect: null, now: at }), { action: 'redirect', url: `${PR}?w=1#diff-abc` });
    const fromConversation = seen('https://github.com/acme/widgets/pull/7');
    assert.equal(decide({ href: PR, prev: fromConversation, pref: true, redirect: null, now: at }).action, 'redirect');
  });
  test('with the setting off, or already on w=1, nothing happens', () => {
    assert.deepEqual(decide({ href: PR, prev: null, pref: false, redirect: null, now: at }), { action: 'none' });
    assert.deepEqual(decide({ href: `${PR}?w=1`, prev: seen(PR), pref: true, redirect: { from: PR, at }, now: at + 500 }), { action: 'none' });
    assert.deepEqual(decide({ href: 'https://github.com/acme/widgets/pull/7', prev: null, pref: true, redirect: null, now: at }), { action: 'none' });
  });
  test("GitHub's own toggle becomes the setting", () => {
    assert.deepEqual(decide({ href: `${PR}?w=1`, prev: seen(PR), pref: false, redirect: null, now: at }), { action: 'save', value: true });
    assert.deepEqual(decide({ href: `${PR}?w=0`, prev: seen(`${PR}?w=1`), pref: true, redirect: null, now: at }), { action: 'save', value: false });
    // turning it off can just drop w from the same page
    assert.deepEqual(decide({ href: PR, prev: seen(`${PR}?w=1`), pref: true, redirect: null, now: at }), { action: 'save', value: false });
    assert.deepEqual(decide({ href: PR, prev: seen(`${PR}?w=1`), pref: false, redirect: null, now: at }), { action: 'none' });
  });
  test('w=1 on a different page or view is not a toggle off', () => {
    const other = seen('https://github.com/acme/widgets/pull/8/changes?w=1');
    assert.equal(decide({ href: PR, prev: other, pref: true, redirect: null, now: at }).action, 'redirect');
    const files = seen('https://github.com/acme/widgets/pull/7/files?w=1');
    assert.equal(decide({ href: PR, prev: files, pref: true, redirect: null, now: at }).action, 'redirect');
  });
  test("doesn't loop when GitHub drops the w=1 it was sent", () => {
    const redirect = { from: PR, at };
    assert.deepEqual(decide({ href: PR, prev: seen(PR), pref: true, redirect, now: at + 2000 }), { action: 'none' });
    // much later, the same URL may be redirected again
    assert.equal(decide({ href: PR, prev: seen(PR), pref: true, redirect, now: at + REDIRECT_GUARD_MS + 1 }).action, 'redirect');
  });
});

describe('GitHub Hide whitespace: the saved setting', () => {
  const fakeStorage = (initial = null) => {
    const box = { v: initial };
    return { box, load: async () => box.v, store: async v => { box.v = v; } };
  };
  const down = async () => ({ ok: false, status: 0, error: 'unreachable' });

  test('is the same prefs.json setting the local page uses', async () => {
    const home = tmp('home');
    const b = await startBridge({ home });
    try {
      const call = async (method, p, body) => { const r = await b.call(method, p, body); return { ok: r.status === 200, body: r.body }; };
      const s = fakeStorage();
      const prefs = prefsStore({ call, ...s });
      assert.equal(await prefs.read(), false);
      assert.equal(await prefs.write(true), true);
      assert.deepEqual((await b.call('GET', '/api/prefs')).body, { hideWhitespace: true, diffView: 'unified' });
      assert.deepEqual(s.box.v, { hideWhitespace: true });
    } finally { await b.close(); }
  });

  test('falls back to chrome.storage when the bridge is down, and sends the change when it is back', async () => {
    const s = fakeStorage({ hideWhitespace: false });
    const offline = prefsStore({ call: down, ...s });
    assert.equal(await offline.write(true), false);
    assert.deepEqual(s.box.v, { hideWhitespace: true, dirty: true });
    assert.equal(await offline.read(), true);

    const sent = [];
    let saved = false;
    const call = async (method, p, body) => {
      if (method === 'POST') { sent.push(body); saved = body.hideWhitespace; return { ok: true, body: { hideWhitespace: saved } }; }
      return { ok: true, body: { hideWhitespace: saved } };
    };
    const online = prefsStore({ call, ...s });
    assert.equal(await online.read(), true);
    assert.deepEqual(sent, [{ hideWhitespace: true }]);
    assert.deepEqual(s.box.v, { hideWhitespace: true }, 'no longer dirty');
  });

  test('takes the bridge value over a clean copy', async () => {
    const s = fakeStorage({ hideWhitespace: true });
    const prefs = prefsStore({ call: async () => ({ ok: true, body: { hideWhitespace: false } }), ...s });
    assert.equal(await prefs.read(), false);
    assert.deepEqual(s.box.v, { hideWhitespace: false });
  });
});
