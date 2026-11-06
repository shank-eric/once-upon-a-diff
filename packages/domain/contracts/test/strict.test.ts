/*
 * The strict check a writer makes (src/files/strict.ts) against the lenient readers (src/files/schemas.ts): what a writer may
 * give is a subset of what a reader takes, a line a writer builds wrongly is named, and every shape a live writer makes (the
 * 11/6 census of ~/.once-upon) passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readAgentEvent,
  readBacklogEvent,
  readBuild,
  readFixRequest,
  readInboxEntry,
} from '../src/files/schemas.ts';
import {
  strictAgentEvent,
  strictBacklogEvent,
  strictBuild,
  strictFixRequest,
  strictInboxEntry,
} from '../src/files/strict.ts';

const TIME = '2026-11-06T09:00:00.000Z';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const agent = (over: Record<string, unknown>) => ({
  v: 1,
  op: 'beat',
  id: 'eeea873a:write-checks',
  sid8: 'eeea873a',
  name: 'write-checks',
  at: TIME,
  by: 'cli',
  run: 'r_0123456789',
  n: 1,
  of: 6,
  step: 'read',
  note: '',
  ...over,
});
const start = (over: Record<string, unknown> = {}) =>
  agent({
    op: 'start',
    kind: 'author',
    task: 'card B',
    session: 'eeea873a-0000-4000-8000-000000000000',
    model: 'sonnet',
    effort: 'high',
    repo: 'shank-eric/once-upon-a-diff',
    branch: 'write-checks',
    tip: null,
    pr: null,
    cwd: '/x',
    card: 'bl_mw4p3n9h7dadb2',
    lane: null,
    notes: null,
    standing: false,
    ...over,
  });
const backlog = (event: string, over: Record<string, unknown> = {}) => ({
  op: event,
  id: 'bl_mw4p3n9h7dadb2',
  by: 'cli',
  at: TIME,
  ...over,
});
const entry = (type: string, over: Record<string, unknown> = {}) => ({
  type,
  id: 'q_mw4p3n9h',
  at: TIME,
  story: 'EverFi-everfi-frontend-6943',
  kind: 'github',
  title: 'A PR',
  repo: 'EverFi/everfi-frontend',
  ...over,
});

const ACCEPTED: [string, unknown, (v: unknown) => string[], (v: unknown) => unknown][] = [
  ['start', start(), strictAgentEvent, readAgentEvent],
  [
    'start, cardless',
    start({ card: null, repo: null, branch: null }),
    strictAgentEvent,
    readAgentEvent,
  ],
  ['start, editor', start({ kind: 'editor', slots: 3 }), strictAgentEvent, readAgentEvent],
  [
    'state',
    agent({ op: 'state', state: 'plan', outcome: 'plan ready', findings: null, notes: null }),
    strictAgentEvent,
    readAgentEvent,
  ],
  [
    'state, no run (an old run)',
    agent({ op: 'state', state: 'running', run: undefined }),
    strictAgentEvent,
    readAgentEvent,
  ],
  ['beat', agent({}), strictAgentEvent, readAgentEvent],
  [
    'finish of a run an older writer named',
    agent({ op: 'finish', state: 'done', run: 'r_old' }),
    strictAgentEvent,
    readAgentEvent,
  ],
  [
    'finish',
    agent({
      op: 'finish',
      state: 'done',
      result: { commit: SHA, branch: 'x/y', card: 'bl_mw4p3n9h7dadb2', pr: 3 },
      findings: 0,
    }),
    strictAgentEvent,
    readAgentEvent,
  ],
  [
    'finish, no result',
    agent({ op: 'finish', state: 'stopped', result: null }),
    strictAgentEvent,
    readAgentEvent,
  ],
  [
    'add',
    backlog('add', { title: 'T', note: null, repo: 'a/b', branch: null }),
    strictBacklogEvent,
    readBacklogEvent,
  ],
  [
    'start',
    backlog('start', { branch: 'feat/x', repo: null }),
    strictBacklogEvent,
    readBacklogEvent,
  ],
  [
    'assign',
    backlog('assign', { session: 'abcd1234-aaaa', branch: null }),
    strictBacklogEvent,
    readBacklogEvent,
  ],
  [
    'claim, no sid',
    backlog('claim', { agent: 'ou-x', sid: null, session: null, worktree: null }),
    strictBacklogEvent,
    readBacklogEvent,
  ],
  ['done', backlog('done', { sha: SHA }), strictBacklogEvent, readBacklogEvent],
  [
    'edit clearing a repo',
    backlog('edit', { repo: '', note: '' }),
    strictBacklogEvent,
    readBacklogEvent,
  ],
  ['move', backlog('move', { before: 'bl_abc123' }), strictBacklogEvent, readBacklogEvent],
  ['hold', backlog('hold', { on: true }), strictBacklogEvent, readBacklogEvent],
  [
    'question',
    entry('question', { step: 2, chapter: 'c', file: null, text: 'why?', url: null }),
    strictInboxEntry,
    readInboxEntry,
  ],
  [
    'read, local story',
    entry('read', {
      kind: 'local',
      repo: 'my-folder',
      chapter: 'ch-1',
      step: null,
      head_sha: null,
    }),
    strictInboxEntry,
    readInboxEntry,
  ],
  [
    'approved',
    entry('approved', { head_sha: 'abc', branch: null }),
    strictInboxEntry,
    readInboxEntry,
  ],
  [
    'review_comment',
    entry('review_comment', { chapter: null, path: 'a.ts', line: 3, started: true }),
    strictInboxEntry,
    readInboxEntry,
  ],
];

test('strict accepts what the current writers write, and every such line is one the readers take, unchanged', () => {
  for (const [name, value, strict, read] of ACCEPTED) {
    assert.deepEqual(strict(value), [], name);
    assert.notEqual(read(value), null, name);
  }
});

const REFUSED: [string, unknown, (v: unknown) => string[], RegExp][] = [
  [
    'an id that is not sid8:name',
    agent({ id: 'eeea873a:other' }),
    strictAgentEvent,
    /id is not sid8:name/,
  ],
  [
    'a run that is not r_ and 10 hex',
    start({ run: 'r_abc' }),
    strictAgentEvent,
    /run: is not a run id/,
  ],
  ['a start with no run', start({ run: undefined }), strictAgentEvent, /run/],
  [
    'an alias kind (the registry canonicalizes first)',
    start({ kind: 'builder' }),
    strictAgentEvent,
    /kind/,
  ],
  ['a start with no task', start({ task: '' }), strictAgentEvent, /task/],
  ['a card that is not bl_', start({ card: 'card-1' }), strictAgentEvent, /card: is not a card id/],
  [
    'a finish result card that is not bl_',
    agent({ op: 'finish', state: 'done', result: { card: 'x' } }),
    strictAgentEvent,
    /result\.card/,
  ],
  [
    'a commit that is not hex',
    agent({ op: 'finish', state: 'done', result: { commit: 'HEAD' } }),
    strictAgentEvent,
    /result\.commit/,
  ],
  [
    'a repo that is not owner/name',
    start({ repo: 'esshank' }),
    strictAgentEvent,
    /repo: is not owner\/name/,
  ],
  [
    'a time with no milliseconds',
    agent({ at: '2026-11-06T09:00:00Z' }),
    strictAgentEvent,
    /at: is not an ISO time/,
  ],
  [
    'a state that is not one of the five',
    agent({ op: 'state', state: 'busy' }),
    strictAgentEvent,
    /state/,
  ],
  ['a wrong-typed field a reader would drop', start({ pr: 'three' }), strictAgentEvent, /pr/],
  ['a backlog event with no time', backlog('drop', { at: undefined }), strictBacklogEvent, /at/],
  ['a backlog event with no author', backlog('drop', { by: '' }), strictBacklogEvent, /by/],
  [
    'a card id that is not one',
    backlog('drop', { id: 'x' }),
    strictBacklogEvent,
    /id: is not a card id/,
  ],
  [
    'a backlog repo that is not owner/name',
    backlog('add', { title: 'T', repo: 'a b' }),
    strictBacklogEvent,
    /repo/,
  ],
  ['a done sha that is not hex', backlog('done', { sha: 'main' }), strictBacklogEvent, /sha/],
  [
    'a claim whose sid is not 8 hex',
    backlog('claim', { agent: 'ou-x', sid: 'abc' }),
    strictBacklogEvent,
    /sid/,
  ],
  ['an op nobody knows', backlog('rename'), strictBacklogEvent, /op/],
  ['a type nobody reads', entry('position'), strictInboxEntry, /type/],
  [
    'a story that is not an id',
    entry('question', { story: '../x', text: 't' }),
    strictInboxEntry,
    /story: is not a story id/,
  ],
  ['a question with no text', entry('question', { text: '' }), strictInboxEntry, /text/],
  ['an approval with no head', entry('approved', { head_sha: '' }), strictInboxEntry, /head_sha/],
  [
    'an inbox line with no time',
    entry('read', { chapter: 'c', at: undefined }),
    strictInboxEntry,
    /at/,
  ],
];

test('strict names what is wrong with a line a writer builds wrongly', () => {
  for (const [name, value, strict, message] of REFUSED) {
    const found = strict(value).join('; ');
    assert.match(found, message, name);
  }
});

test('builds.json and fixes.json: a request is checked with the key it is written under', () => {
  const build = (over: Record<string, unknown> = {}) => ({
    id: 'b_mw4p3n9h',
    repo: 'EverFi/everfi-frontend',
    number: 6933,
    requested_at: TIME,
    status: 'pending',
    ...over,
  });
  assert.deepEqual(strictBuild(build(), 'everfi/everfi-frontend#6933'), []);
  assert.deepEqual(
    strictBuild(build({ repo: null, number: null, story: 'local-x' }), 'story:local-x'),
    [],
  );
  assert.deepEqual(
    strictBuild(build({ repo: 'my-folder', number: null }), 'story:local-y'),
    [],
    'a local story names no GitHub repo',
  );
  assert.match(
    strictBuild(build(), 'everfi/other#1').join(),
    /key everfi\/other#1 is not the PR's key/,
  );
  assert.match(strictBuild(build({ number: null }), 'x').join(), /no PR number/);
  assert.match(
    strictBuild(build({ repo: 'nope' }), 'nope#6933').join(),
    /repo: is not owner\/name/,
  );
  assert.match(
    strictBuild(build({ status: 'someday' }), 'everfi/everfi-frontend#6933').join(),
    /status/,
  );
  const fix = (over: Record<string, unknown> = {}) => ({
    id: 'f_mw4p3n9h',
    story: 'local-x',
    kind: 'local',
    requested_at: TIME,
    status: 'pending',
    notes: [{ id: 'n_1', path: 'a.ts', side: 'R', line: null, body: 'fix it' }],
    ...over,
  });
  assert.deepEqual(strictFixRequest(fix(), 'f_mw4p3n9h'), []);
  assert.match(strictFixRequest(fix(), 'f_other').join(), /not the request's id/);
  assert.match(strictFixRequest(fix({ story: '../x' }), 'f_mw4p3n9h').join(), /story/);
  assert.match(strictFixRequest(fix({ notes: [{ id: 'n_1' }] }), 'f_mw4p3n9h').join(), /notes/);
  assert.notEqual(readBuild(build()), null);
  assert.notEqual(readFixRequest(fix()), null);
});
