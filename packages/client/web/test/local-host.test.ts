import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_HOST_LINKS } from '../public/local/host.ts';

const since = { from: 'a'.repeat(40), to: 'b'.repeat(40) };

test('the local page has no host range page and nowhere to post drafts', () => {
  assert.equal(LOCAL_HOST_LINKS.rangeLink('https://github.com/acme/widgets/pull/7', since), null);
  assert.equal(
    LOCAL_HOST_LINKS.backFromRange('https://github.com/acme/widgets/pull/7', since),
    null,
  );
  assert.equal(LOCAL_HOST_LINKS.canPostDrafts, false);
});
