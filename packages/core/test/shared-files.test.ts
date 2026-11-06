/*
 * The four files the CLI and the bridge share, plus fixes.json, read through core's stores against the old-form files the
 * contracts package keeps (contracts/test/fixtures/files): what a reader takes is what the formats accept, a record the
 * queue's check refuses is carried through every write, and a writer's malformed line is written anyway and logged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.ts';
import { Inbox } from '../src/queues/requests/inbox.ts';
import { Builds } from '../src/queues/requests/builds.ts';
import { readFixes } from '../src/queues/requests/fixes.ts';
import { RequestQueue } from '../src/queues/requests/queue.ts';
import { BacklogStore, foldBacklog } from '../src/queues/backlog/backlog.ts';
import { foldAgentEvents, parseAgentEvents } from '../src/records/agents/events.ts';
import { AgentRegistry } from '../src/records/agents/registry.ts';
import { noteIfMalformed } from '../src/foundation/shared-files.ts';
import { readBuild, readFixRequest, type Build } from '@once-upon-a-diff/contracts/files/schemas';

const FIXTURES = path.resolve(import.meta.dirname, '../../contracts/test/fixtures/files');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');
const count = (name: string) => fixture(name).split('\n').filter(Boolean).length;
/** A home with the old-form files in it, under their real names. */
function homeWith(files: Record<string, string>): string {
  const home = tmp('shared-files');
  for (const [name, target] of Object.entries(files)) {
    copyFileSync(path.join(FIXTURES, name), path.join(home, target));
  }
  return home;
}

test('agents.jsonl: every line of the old-form file is an event, and the fold tells the agents', () => {
  const events = parseAgentEvents(fixture('agents.jsonl'));
  assert.equal(events.length, count('agents.jsonl'));
  assert.equal(parseAgentEvents(fixture('agents-rejected.jsonl')).length, 0);
  const agents = foldAgentEvents(events);
  assert.deepEqual(
    agents.map((one) => [one.name, one.kind, one.state]),
    [
      ['old-builder', 'author', 'done'],
      ['old-reviewer', 'critic', 'failed'],
      ['editor', 'editor', 'running'],
      ['helper', 'helper', 'running'],
    ],
  );
  assert.equal(agents[0].result?.card, 'bl_abc123');
  assert.equal(agents[2].slots, 3);
});

test('backlog.jsonl: the old-form file folds to its items, and the lines the formats refuse change nothing', () => {
  const items = foldBacklog(fixture('backlog.jsonl'));
  assert.deepEqual(
    items.map((one) => [one.id, one.state, one.title]),
    [
      ['bl_def456', 'open', 'second card, renamed'],
      ['bl_ghi789', 'open', 'third card'],
      ['bl_abc123', 'started', 'first card'],
    ],
  );
  const done = items[2];
  assert.equal(done.landed_sha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(done.hold, true);
  assert.equal(items[1].someday, true);
  assert.equal(foldBacklog(fixture('backlog-rejected.jsonl')).length, 0);
  assert.deepEqual(
    foldBacklog(fixture('backlog.jsonl') + fixture('backlog-rejected.jsonl')),
    items,
  );
});

test('inbox.jsonl: every line of the old-form file is read, and the legacy types are skipped', () => {
  const home = homeWith({ 'inbox.jsonl': 'inbox.jsonl' });
  assert.equal(new Inbox(home).all().length, count('inbox.jsonl'));
  const mixed = tmp('shared-files');
  writeFileSync(
    path.join(mixed, 'inbox.jsonl'),
    fixture('inbox-legacy.jsonl') + fixture('inbox.jsonl'),
  );
  const inbox = new Inbox(mixed);
  const { entries, offset } = inbox.readFrom(0);
  assert.equal(entries.length, count('inbox.jsonl'));
  assert.equal(offset, readFileSync(inbox.file).length, 'a skipped line still moves the cursor on');
  const [first] = inbox.questions('acme-widgets-7');
  assert.deepEqual(
    [first.id, first.step, first.chapter, first.answers.length],
    ['q_1', 2, 'Chapter 2: x', 1],
  );
});

test('builds.json and fixes.json: the old-form records are read, started_at and unknown fields included', () => {
  const home = homeWith({ 'builds.json': 'builds.json', 'fixes.json': 'fixes.json' });
  const builds = new Builds(home).all();
  assert.deepEqual(Object.keys(builds), [
    'acme/widgets#7',
    'acme/widgets#8',
    'story:local-x',
    'acme/widgets#9',
  ]);
  assert.equal(builds['acme/widgets#8'].started_at, '2026-10-22T19:11:00Z');
  assert.deepEqual(Object.keys(readFixes(home)), ['f_1', 'f_2', 'f_3']);
  assert.equal(readFixes(home).f_2.notes[0].from_draft, false);
});

/** Four builds, the second and fourth of which the check refuses. */
function queueWithJunk() {
  const home = tmp('shared-files');
  const file = path.join(home, 'builds.json');
  const ok = (id: string) => ({ id, requested_at: '2026-10-24T19:10:00Z', status: 'pending' });
  const raw = {
    'acme/widgets#1': ok('b_1'),
    'acme/widgets#2': {
      id: 'b_2',
      requested_at: '2026-10-24T19:10:00Z',
      status: 'someday',
      odd: true,
    },
    'acme/widgets#3': ok('b_3'),
    'acme/widgets#4': 'not a record',
  };
  writeFileSync(file, JSON.stringify(raw, null, 2));
  return { file, raw, queue: new RequestQueue(file, { claimFreshMs: null, check: readBuild }) };
}
const keysOf = (file: string) => Object.keys(JSON.parse(readFileSync(file, 'utf8')));

test('a record the check refuses is hidden from the queue and carried through a write, in the file’s order', () => {
  const { file, raw, queue } = queueWithJunk();
  assert.deepEqual(Object.keys(queue.all()), ['acme/widgets#1', 'acme/widgets#3']);
  queue.claim('b_3', 'claude');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after), Object.keys(raw), 'same order, nothing dropped');
  assert.deepEqual(after['acme/widgets#2'], raw['acme/widgets#2']);
  assert.equal(after['acme/widgets#4'], 'not a record');
  assert.equal(after['acme/widgets#3'].claimed_by, 'claude');
});

test('a write that removes a record, or adds one, leaves the refused records and the order alone', () => {
  const { file, queue } = queueWithJunk();
  queue.update((all) => {
    delete all['acme/widgets#1'];
    all['acme/widgets#5'] = {
      id: 'b_5',
      requested_at: '2026-10-25T19:10:00Z',
      status: 'pending',
    } as never;
  });
  assert.deepEqual(keysOf(file), [
    'acme/widgets#2',
    'acme/widgets#3',
    'acme/widgets#4',
    'acme/widgets#5',
  ]);
});

test('a new request under the key of a refused record replaces it', () => {
  const { file, queue } = queueWithJunk();
  queue.update((all) => {
    all['acme/widgets#2'] = {
      id: 'b_new',
      requested_at: '2026-10-25T19:10:00Z',
      status: 'pending',
    } as never;
  });
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after['acme/widgets#2'].id, 'b_new');
  assert.equal(after['acme/widgets#2'].odd, undefined);
  assert.deepEqual(keysOf(file), [
    'acme/widgets#1',
    'acme/widgets#2',
    'acme/widgets#3',
    'acme/widgets#4',
  ]);
});

test('an update that changes nothing does not rewrite the file', () => {
  const { file, queue } = queueWithJunk();
  const before = readFileSync(file, 'utf8');
  queue.update(() => 0);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('everything the stores write reads back through the formats, and none of it is logged as malformed', () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (message: string) => logged.push(message);
  try {
    const home = tmp('shared-files');
    const registry = new AgentRegistry(home);
    const sid = 'abcd1234';
    registry.start({
      name: 'author-x',
      sid,
      kind: 'author',
      task: 't',
      repo: 'acme/widgets',
      branch: 'feat-x',
      pr: 3,
      card: 'bl_abc123',
      lane: 'l',
    });
    registry.beat('author-x', { sid, n: 1, of: 3, step: 'read', note: 'n' });
    registry.state('author-x', { sid, state: 'fixing', findings: 2, outcome: 'o' });
    registry.finish('author-x', {
      sid,
      state: 'done',
      outcome: 'ok',
      result: {
        commit: '0123456789abcdef0123456789abcdef01234567',
        branch: 'feat-x',
        card: 'bl_abc123',
      },
    });
    registry.start({ name: 'ed', sid, kind: 'editor', task: 'queue', slots: 2 });
    const text = readFileSync(path.join(home, 'agents.jsonl'), 'utf8');
    assert.equal(parseAgentEvents(text).length, text.split('\n').filter(Boolean).length);

    const backlog = new BacklogStore(home);
    const item = backlog.add({ title: 'a', note: 'n', repo: 'acme/widgets' });
    const other = backlog.add({ title: 'b' });
    backlog.start(item.id, { branch: 'feat-x' });
    backlog.assign(other.id, { session: 'abcd1234-aaaa' });
    backlog.claim(item.id, { agent: 'author-x', sid });
    backlog.hold(item.id, true);
    backlog.move(other.id, { edge: 'top' });
    backlog.move(other.id, { before: item.id });
    backlog.edit(other.id, { title: 'b2', note: null });
    backlog.done(item.id, { sha: '0123456789abcdef0123456789abcdef01234567' });
    backlog.drop(other.id);
    backlog.reopen(other.id);
    const lines = readFileSync(path.join(home, 'backlog.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    assert.equal(lines.length, 12);
    assert.equal(foldBacklog(lines.join('\n')).length, 2);

    const inbox = new Inbox(home);
    const question = inbox.append({
      type: 'question',
      story: 's',
      step: 1,
      chapter: 'c',
      file: null,
      text: 'why?',
    });
    inbox.append({
      type: 'answer',
      question: question.id,
      story: 's',
      text: 'because',
      by: 'claude',
    });
    inbox.append({
      type: 'read',
      story: 's',
      chapter: 'ch-1',
      step: 1,
      title: 'T',
      head_sha: null,
      story_head: null,
      reason: 'time',
    });
    assert.equal(inbox.all().length, 3);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, []);
});

test('a writer’s malformed line is written anyway, and logged', () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (message: string) => logged.push(message);
  try {
    noteIfMalformed('/x/agents.jsonl', { op: 'beat' }, () => null);
    noteIfMalformed('/x/agents.jsonl', { op: 'beat' }, () => ({}));
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /agents\.jsonl: a line was written/);
});

test('a record from a newer writer keeps the fields this reader does not take through a write of another field', () => {
  const home = tmp('shared-files');
  const file = path.join(home, 'builds.json');
  const newer = {
    id: 'b_1',
    repo: 'acme/widgets',
    number: 7,
    url: null,
    requested_at: '2026-10-24T19:10:00Z',
    status: 'pending',
    mode: 'sideways',
    kind: 'hologram',
    reads: [
      { chapter: 'ch-1', at: '2026-10-24T19:00:00Z' },
      { chapter: 7, at: 'a read this reader cannot take' },
    ],
    from_a_later_card: { x: 1 },
  };
  const other = { id: 'b_2', requested_at: '2026-10-24T19:11:00Z', status: 'pending' };
  writeFileSync(
    file,
    JSON.stringify({ 'acme/widgets#7': newer, 'acme/widgets#8': other }, null, 2),
  );
  const builds = new Builds(home);
  builds.queue.claim('b_1', 'claude');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after['acme/widgets#7'], {
    ...newer,
    claimed_by: 'claude',
    claimed_at: after['acme/widgets#7'].claimed_at,
  });
  assert.ok(after['acme/widgets#7'].claimed_at);
  assert.deepEqual(
    after['acme/widgets#8'],
    other,
    'a record the write did not touch is as it was, defaults not added',
  );
  // a write that sets the field the reader could not take replaces it
  builds.queue.update((all) => {
    all['acme/widgets#7'].mode = 'update';
  });
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))['acme/widgets#7'].mode, 'update');
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))['acme/widgets#7'].kind, 'hologram');
});

test('a fix request with a note the schema refuses keeps every note through a write', () => {
  const home = tmp('shared-files');
  copyFileSync(path.join(FIXTURES, 'fixes.json'), path.join(home, 'fixes.json'));
  const raw = JSON.parse(readFileSync(path.join(home, 'fixes.json'), 'utf8'));
  const queue = new RequestQueue(path.join(home, 'fixes.json'), {
    claimFreshMs: null,
    check: readFixRequest,
  });
  queue.claim('f_3', 'claude');
  const after = JSON.parse(readFileSync(path.join(home, 'fixes.json'), 'utf8'));
  assert.deepEqual(
    after.f_3.notes,
    raw.f_3.notes,
    'all three notes, the whole-file one and the odd one included',
  );
  assert.equal(after.f_3.claimed_by, 'claude');
});

test('a record written fresh over a key takes the fresh record whole, and one changed in place merges into the one on disk', () => {
  const home = tmp('shared-files');
  const file = path.join(home, 'builds.json');
  const base = { requested_at: '2026-10-24T19:10:00Z', status: 'pending' };
  writeFileSync(
    file,
    JSON.stringify({
      'acme/widgets#1': { id: 'b_1', ...base, mode: 'future', kind: 'hologram' },
      'acme/widgets#2': {
        id: 'b_2',
        ...base,
        mode: 'rebuild',
        local: { repo_path: 5, base: 'main', head: 'feat' },
      },
    }),
  );
  const queue = new RequestQueue<Build>(file, { claimFreshMs: null, check: readBuild });
  queue.update((all) => {
    all['acme/widgets#1'] = { id: 'b_new', ...base } as Build; // a new request for the key
    all['acme/widgets#2'].local!.base = 'dev'; // a nested field changed in place
  });
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(
    after['acme/widgets#1'],
    { id: 'b_new', ...base },
    'nothing of the old record is kept',
  );
  assert.deepEqual(
    after['acme/widgets#2'].local,
    { repo_path: 5, base: 'dev', head: 'feat' },
    'the nested field the check refused (repo_path: 5) survives',
  );
  assert.equal(after['acme/widgets#2'].mode, 'rebuild');
});
