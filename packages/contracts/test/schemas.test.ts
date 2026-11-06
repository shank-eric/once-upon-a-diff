import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBody, BODIES, type BodyName } from '../src/schemas.ts';

const ok = <Name extends BodyName>(name: Name, body: unknown) => {
  const checked = checkBody(name, body);
  assert.ok(checked.ok, `${name} should take ${JSON.stringify(body)}`);
  return checked.ok ? checked.output : null;
};
const bad = (name: BodyName, body: unknown, message?: string | RegExp) => {
  const checked = checkBody(name, body);
  assert.ok(!checked.ok, `${name} should refuse ${JSON.stringify(body)}`);
  if (!checked.ok && message) {
    assert.match(checked.message, message instanceof RegExp ? message : new RegExp(`^${message}$`));
  }
};

test('a body that is not an object is refused by every schema', () => {
  for (const name of Object.keys(BODIES) as BodyName[]) {
    // a list passes valibot's `object` but never reaches it: the bridge's readBody refuses one first (request.ts)
    for (const body of [null, 5, 'x', undefined]) {
      bad(name, body);
    }
  }
});

test('a message never carries the value that was refused', () => {
  const checked = checkBody('boardFocus', { session: 'SECRET value with spaces' });
  assert.deepEqual(checked, { ok: false, message: 'a session id is needed' });
  const wrong = checkBody('boardBacklogAdd', { title: { secret: 'value' } });
  assert.deepEqual(wrong, { ok: false, message: 'title is not valid' });
});

test('fields the schema does not list are dropped, __proto__ included', () => {
  const out = ok('boardFocus', JSON.parse('{"session":"s1","extra":1,"__proto__":{"admin":true}}'));
  assert.deepEqual(out, { session: 's1' });
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal((out as Record<string, unknown>).admin, undefined);
});

test('page settings: nonsense is dropped, a bad view is unified, one size leaves the other', () => {
  assert.deepEqual(ok('prefs', { diffView: 'sideways' }), { diffView: 'unified' });
  assert.deepEqual(ok('prefs', { hideWhitespace: 'yes' }), { hideWhitespace: false });
  assert.deepEqual(ok('prefs', { layout: { width: 612.4 } }), { layout: { width: 612.4 } });
  assert.deepEqual(ok('prefs', { layout: { width: 'wide', chatHeight: 330 } }), {
    layout: { width: null, chatHeight: 330 },
  });
  assert.deepEqual(ok('prefs', { layout: 5 }), { layout: null });
  assert.deepEqual(ok('prefs', {}), {});
});

test('status-many takes at most 200 PRs, and a list that is not PRs gets none', () => {
  const prs = Array.from({ length: 300 }, (_, index) => ({ repo: 'acme/w', number: index + 1 }));
  assert.equal(ok('statusMany', { prs })!.prs.length, 200);
  assert.deepEqual(ok('statusMany', { prs: 'nope' })!.prs, []);
  assert.deepEqual(ok('statusMany', {})!.prs, []);
});

test('a build request names its repo and number, with the page’s own messages', () => {
  assert.deepEqual(ok('buildRequest', { repo: 'a/b', number: 3 }), {
    repo: 'a/b',
    number: 3,
    retell: false,
  });
  bad('buildRequest', { number: 3 }, 'bad repo');
  bad('buildRequest', { repo: 'a/b' }, 'bad number');
  assert.equal(ok('buildRequest', { repo: 'a/b', number: '7', retell: true })!.retell, true);
});

test('the panel’s state keeps the numbers whole and the flags true or false', () => {
  assert.deepEqual(ok('ui', { n: '3', width: 400.7, all: true, chatHeight: null }), {
    n: 3,
    all: true,
    collapsed: false,
    width: 400,
    hidden: false,
    filesOpen: false,
    chatOpen: false,
    chatHeight: null,
  });
  assert.equal(ok('ui', {})!.n, 0);
});

test('a question needs its text, and is clipped where the bridge always clipped it', () => {
  bad('questionAsk', {}, 'text is required');
  bad('questionAsk', { text: 5 }, 'text is required');
  const out = ok('questionAsk', {
    text: 'x'.repeat(9000),
    chapter: 'c'.repeat(400),
    step: 2,
    file: null,
  })!;
  assert.equal(out.text.length, 8000);
  assert.equal(out.chapter!.length, 300);
  assert.equal(out.file, null);
  assert.equal(out.url, null);
  assert.equal(out.step, 2);
});

test('question marks: an action the bridge knows, its ids capped, seen only as a map', () => {
  bad('questionMarks', { action: 'explode' }, /^action is one of clear, read_all, dismiss/);
  const ids = Array.from({ length: 600 }, (_, index) => `q${index}`);
  assert.equal(ok('questionMarks', { action: 'dismiss', ids })!.ids.length, 500);
  assert.equal(ok('questionMarks', { action: 'read', seen: 'x' })!.seen, null);
  assert.equal(
    ok('questionMarks', { action: 'read', seen: [] })!.seen,
    null,
    'a list is not a map',
  );
  assert.deepEqual(ok('questionMarks', { action: 'read', seen: { q1: 'x' }, auto: true })!.seen, {
    q1: 'x',
  });
});

test('drafts, fixes, pr and push take the actions they take and say so otherwise', () => {
  bad(
    'draftsAct',
    { chapter: 1, index: 0, action: 'delete' },
    'action must be dismiss, restore or settle',
  );
  assert.equal(ok('draftsAct', { chapter: '1', index: 0, action: 'review' })!.chapter, 1);
  bad('fixesAct', { action: 'drop' }, 'action is one of send, auto, take_back');
  assert.deepEqual(ok('fixesAct', { action: 'take_back', request: null })!.request, null);
  bad('prPush', { action: 'force' }, 'action must be push or push-ahead');
  bad('pushApproved', { action: 'push-ahead' }, 'action must be push');
  ok('pushApproved', { action: 'push', head_sha: 'abc' });
  bad('pushApproved', { action: 'push', head_sha: 5 });
});

test('the board’s bodies keep their messages: a session id, a kind, a flag, an edge', () => {
  bad('boardFocus', { session: '../x' }, 'a session id is needed');
  bad('boardFocus', {}, 'a session id is needed');
  bad(
    'boardType',
    { kind: 'other', session: 's1' },
    'a kind \\(build or listen\\) and a session id are needed',
  );
  assert.deepEqual(ok('boardType', { kind: 'listen', session: 's1', repo: 'a/b' }), {
    kind: 'listen',
    session: 's1',
    repo: 'a/b',
  });
  bad('boardVoicePause', { paused: 'yes' }, 'paused \\(true or false\\) is needed');
  bad('boardVoicePhone', {}, 'on \\(true or false\\) is needed');
  bad(
    'boardBacklogMove',
    { id: 'bl_abcdef' },
    'before \\(an item id\\) or edge \\(top or bottom\\) is needed',
  );
  bad('boardBacklogMove', { id: 'bl_abcdef', edge: 'middle' }, /before \(an item id\) or edge/);
  assert.deepEqual(ok('boardBacklogMove', { id: 'bl_abcdef', edge: 'top' }), {
    id: 'bl_abcdef',
    edge: 'top',
  });
  bad('boardBacklogEdit', { title: 'x' }, 'a backlog item id is needed');
  assert.deepEqual(ok('boardBacklogEdit', { id: 'bl_abcdef', note: null }), {
    id: 'bl_abcdef',
    note: null,
  });
  bad('boardBacklogAssign', { id: 'nope' }, 'a backlog item id is needed');
  assert.deepEqual(ok('boardBacklogAssign', { id: 'bl_abcdef' }), { id: 'bl_abcdef' });
});

test('worktree clean: ack and ignored take a string or a list, empty ones dropped, at most 100', () => {
  const out = ok('boardWorktreeClean', {
    path: '/a/b',
    ack: 'superseded',
    ignored: ['x', '', ...Array.from({ length: 200 }, (_, index) => `f${index}`)],
  })!;
  assert.deepEqual(out.ack, ['superseded']);
  assert.equal(out.ignored.length, 100);
  assert.deepEqual(ok('boardWorktreeClean', { path: '/a' })!.ack, []);
});

test('the question actions match the bridge’s own list', async () => {
  // the bridge refuses an action it doesn't know too (inbox/conversation.ts), so the two lists have to agree
  const bridge = await import('../../state/src/queues/requests/conversation.ts');
  for (const action of bridge.QA_ACTIONS) {
    ok('questionMarks', { action });
  }
});
