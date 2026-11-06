import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { stateFile } from '@once-upon-a-diff/foundation/settings';
import { readBinding, writeBinding } from '../src/records/listeners/binding.ts';
import { Inbox } from '../src/queues/requests/inbox.ts';

const modeOf = (file: string) => (statSync(file).mode & 0o777).toString(8);

test("reading a story's state makes no folder, and the first write makes it", () => {
  const home = tmp('home');
  const story = 'pr-octo-org-web-app-42';
  assert.equal(stateFile(home, story, 'agent.json'), path.join(home, 'state', story, 'agent.json'));
  assert.equal(readBinding(home, story), null);
  assert.equal(existsSync(path.join(home, 'state')), false, 'a read left a folder behind');

  writeBinding(home, story, 'fix-thing', null);
  assert.equal(readBinding(home, story)?.agent, 'fix-thing');
  assert.deepEqual(readdirSync(path.join(home, 'state', story)), ['agent.json']);
});

test("a new Inbox on a home that's there leaves its mode alone until the first write", () => {
  const home = tmp('home');
  chmodSync(home, 0o755);
  const inbox = new Inbox(home);
  assert.equal(modeOf(home), '755');
  inbox.all();
  inbox.getCursor('claude');
  assert.equal(modeOf(home), '755', 'a read changed the home');
  assert.equal(existsSync(path.join(home, 'cursors')), false, 'a read made the cursors folder');

  inbox.append({ type: 'question', story: 's', text: 'one' });
  assert.equal(modeOf(home), '700');
  assert.equal(modeOf(inbox.file), '600');
});

test('the first write makes a home that is not there yet, the user alone', () => {
  const home = path.join(tmp('parent'), 'once-upon');
  const inbox = new Inbox(home);
  assert.equal(existsSync(home), false, 'new Inbox made the home');
  inbox.ensureFile();
  assert.equal(modeOf(home), '700');
  assert.equal(modeOf(inbox.file), '600');

  const other = path.join(tmp('parent'), 'once-upon');
  mkdirSync(path.dirname(other), { recursive: true });
  const fresh = new Inbox(other);
  fresh.setCursor('claude', 0);
  assert.equal(modeOf(other), '700');
  assert.equal(fresh.getCursor('claude'), 0);
});
