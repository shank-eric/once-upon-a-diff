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

test('a repo listener’s heartbeat is what notes the listener history, not a read of the board', async () => {
  const { beat, touchHandling } = await import('../src/records/listeners/listeners.ts');
  const { readHistory } = await import('../src/records/listeners/history.ts');
  const home = path.join(tmp('parent'), 'once-upon');
  beat(home, 'repo-acme-widgets', 'waiting', { repo: 'acme/widgets' });
  assert.equal(readHistory(home)['acme/widgets']?.consumer, 'repo-acme-widgets');
  assert.equal(modeOf(home), '700', 'the first write made the home the user’s alone');
  beat(home, 'story-s1', 'waiting', { story: 's1', repo: 'acme/other' });
  assert.equal(readHistory(home)['acme/other'], undefined, 'a story’s listener is not a repo’s');
  beat(home, 'repo-acme-gadgets', 'handling', { repo: 'acme/gadgets' });
  const before = readHistory(home)['acme/gadgets'].last_seen;
  await new Promise((resolve) => setTimeout(resolve, 30));
  touchHandling(home, 'repo-acme-gadgets'); // inside the 20 s throttle: the entry stays
  assert.equal(readHistory(home)['acme/gadgets'].last_seen, before);
});

test('a handover that takes minutes keeps the stretch: the next beat does not restart started_at', async () => {
  const { beat } = await import('../src/records/listeners/listeners.ts');
  const { readHistory } = await import('../src/records/listeners/history.ts');
  const { writeJson } = await import('@once-upon-a-diff/test-kit/files');
  const home = tmp('home');
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  writeJson(path.join(home, 'listener-history.json'), {
    'acme/widgets': {
      repo: 'acme/widgets',
      consumer: 'repo-acme-widgets',
      started_at: hourAgo,
      last_seen: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
  });
  beat(home, 'repo-acme-widgets', 'waiting', { repo: 'acme/widgets' });
  const entry = readHistory(home)['acme/widgets'];
  assert.equal(entry.started_at, hourAgo, 'five minutes of handling is the same stretch');
  assert.ok(Date.now() - Date.parse(entry.last_seen) < 5000, 'and last_seen moved');
});
