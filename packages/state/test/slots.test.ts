/**
 * The one answer to "how many slots is an editor using": the authors it controls that are working (running, at the plan
 * check, or fixing), by the session they were launched from or by the session that claimed their card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { AgentRegistry } from '../src/records/agents/registry.ts';
import { BacklogStore } from '../src/queues/backlog/backlog.ts';
import { DEFAULT_SLOTS, slotsInUse } from '../src/queues/backlog/slots.ts';

const NOW = new Date('2026-11-06T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60000);
const EDITOR_SID = 'abcdef01';
const EDITOR_SESSION = `${EDITOR_SID}-1111-4222-8333-444444444444`;

function world() {
  const home = tmp('slots');
  const registry = new AgentRegistry(home);
  const store = new BacklogStore(home);
  registry.start({
    name: 'editor-one',
    sid: EDITOR_SID,
    session: EDITOR_SESSION,
    kind: 'editor',
    task: 'queue',
    slots: 3,
    at: ago(600),
  });
  const author = (name: string, sid = EDITOR_SID, minutes = 60, card?: string) =>
    registry.start({ name, sid, kind: 'author', task: name, card, at: ago(minutes) });
  const answer = () => {
    const agents = registry.agents();
    const editor = agents.find((one) => one.name === 'editor-one');
    return slotsInUse(editor as NonNullable<typeof editor>, agents, store.items(), NOW.getTime());
  };
  return { registry, store, author, answer };
}

test('running, plan and fixing authors hold a slot; waiting, review and finished ones, critics and helpers do not', () => {
  const { registry, author, answer } = world();
  author('a-running');
  author('b-plan');
  registry.state('b-plan', { state: 'plan', at: ago(50) });
  author('c-fixing');
  registry.state('c-fixing', { state: 'fixing', findings: 2, at: ago(50) });
  author('d-waiting');
  registry.state('d-waiting', { state: 'waiting', at: ago(50) });
  author('e-review');
  registry.state('e-review', { state: 'review', at: ago(50) });
  author('f-done');
  registry.finish('f-done', { at: ago(40) });
  registry.start({ name: 'g-critic', sid: EDITOR_SID, kind: 'critic', task: 'x', at: ago(30) });
  registry.start({ name: 'h-helper', sid: EDITOR_SID, kind: 'helper', task: 'x', at: ago(30) });
  const found = answer();
  assert.equal(found.slots, 3);
  assert.equal(found.in_use, 3);
  assert.equal(found.free, 0);
  assert.deepEqual(found.authors.map((one) => one.name).sort(), [
    'a-running',
    'b-plan',
    'c-fixing',
    'd-waiting',
    'e-review',
  ]);
});

test('an author silent for a day is dead and holds nothing; another editor session’s author is not this editor’s', () => {
  const { author, answer } = world();
  author('ou-silent', EDITOR_SID, 30 * 60);
  author('ou-other', '22222222');
  author('ou-live');
  const found = answer();
  assert.deepEqual(
    found.authors.map((one) => one.name),
    ['ou-live'],
  );
  assert.equal(found.free, 2);
});

test('an author launched from another session is the editor’s when the editor’s session claimed its card', () => {
  const { store, author, answer } = world();
  const card = store.add({ title: 'A card', repo: 'acme/widgets' });
  store.claim(card.id, { agent: 'ou-claimed', session: EDITOR_SESSION });
  author('ou-claimed', '22222222', 60, card.id);
  const other = store.add({ title: 'Another', repo: 'acme/widgets' });
  store.claim(other.id, { agent: 'ou-elsewhere', session: '99999999-1111-4222-8333-444444444444' });
  author('ou-elsewhere', '33333333', 60, other.id);
  assert.deepEqual(
    answer().authors.map((one) => one.name),
    ['ou-claimed'],
  );
});

test('one author fills one editor’s pool: the claim’s session when the card is claimed, else the launching session', () => {
  const { registry, store, author } = world();
  const second = '22222222-1111-4222-8333-444444444444';
  registry.start({
    name: 'editor-two',
    sid: '22222222',
    session: second,
    kind: 'editor',
    task: 'queue',
    slots: 2,
    at: ago(600),
  });
  const count = (name: string) => {
    const agents = registry.agents();
    const found = agents.find((one) => one.name === name);
    return slotsInUse(
      found as NonNullable<typeof found>,
      agents,
      store.items(),
      NOW.getTime(),
    ).authors.map((one) => one.name);
  };
  // launched from the first editor's session, but its card was claimed by the second editor's
  const card = store.add({ title: 'A card', repo: 'acme/widgets' });
  store.claim(card.id, { agent: 'ou-shared', session: second });
  author('ou-shared', EDITOR_SID, 60, card.id);
  // launched from the first editor's session, on a card claimed by a session that is no editor: the launcher's
  const other = store.add({ title: 'Another', repo: 'acme/widgets' });
  store.claim(other.id, { agent: 'ou-main', session: '99999999-1111-4222-8333-444444444444' });
  author('ou-main', EDITOR_SID, 60, other.id);
  author('ou-plain');
  assert.deepEqual(count('editor-one').sort(), ['ou-main', 'ou-plain']);
  assert.deepEqual(count('editor-two'), ['ou-shared']);
});

test('an editor registered with no slots has the default', () => {
  assert.equal(DEFAULT_SLOTS, 3);
});
