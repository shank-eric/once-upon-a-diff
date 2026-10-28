import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPageLink } from '../src/page-links.ts';

const key = 'page.AbC_123-xyz';

test('the extension opens the bridge’s own address or an https host name, to the right page, with a page key', () => {
  for (const url of [
    `http://127.0.0.1:4823/board/#key=${key}`,
    `https://once-upon.test/board/#key=${key}`,
    `https://once-upon.fidev.net/board/#key=${key}`,
  ]) {
    assert.equal(isPageLink('board', url), true, url);
  }
  assert.equal(
    isPageLink('board', `https://once-upon.test/inbox/#key=${key}`),
    false,
    'the review inbox page is gone',
  );
});

test('anything else is refused: other schemes, bare http names, ports on names, other paths, no key, junk after', () => {
  for (const url of [
    undefined,
    null,
    42,
    '',
    `http://once-upon.test/board/#key=${key}`,
    `https://once-upon.test:4823/board/#key=${key}`,
    `https://user@evil.test/board/#key=${key}`,
    `https://evil.test/board/x#key=${key}`,
    `https://evil.test/local/s/#key=${key}`,
    'https://once-upon.test/board/',
    'https://once-upon.test/board/#key=token',
    `https://once-upon.test/board/#key=${key}&x=1`,
    `https://once-upon.test/board/#key=${key}"><script>`,
    `javascript:alert(1)//board/#key=${key}`,
    `http://127.0.0.1/board/#key=${key}`,
    `http://127.0.0.1:4823.evil.test/board/#key=${key}`,
  ]) {
    assert.equal(isPageLink('board', url), false, String(url));
  }
});
