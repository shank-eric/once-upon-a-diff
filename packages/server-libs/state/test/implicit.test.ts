/** `implicitCards`: the cards a registry's runs make, read from agents.jsonl alone. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { AgentRegistry } from '../src/records/agents/registry.ts';
import { implicitCards } from '../src/records/agents/implicit.ts';
import { implicitItems } from '../src/queues/backlog/implicit.ts';
import { BacklogStore } from '../src/queues/backlog/backlog.ts';

const when = (minutes: number) => new Date(Date.UTC(2026, 10, 6, 12, minutes));
const card = (id: string) => ({ ...({} as object), card: id });

test('a card is every run that names an ic_ id: title cut at 80 characters, repo from the first run, the latest branch, claim by the first run', () => {
  const home = tmp('implicit-fold');
  const registry = new AgentRegistry(home);
  const long = `${'word '.repeat(30)}end\nsecond line`;
  registry.start({
    name: 'ou-a',
    sid: 'aaaaaaaa',
    kind: 'author',
    task: long,
    repo: 'acme/widgets',
    ...card('ic_one111111'),
    at: when(0),
  });
  registry.finish('ou-a', { sid: 'aaaaaaaa', at: when(5) });
  registry.start({
    name: 'ou-a',
    sid: 'aaaaaaaa',
    kind: 'author',
    task: 'again',
    branch: 'later-branch',
    ...card('ic_one111111'),
    at: when(10),
  });
  registry.start({
    name: 'review-a',
    sid: 'bbbbbbbb',
    kind: 'critic',
    task: 'review',
    ...card('ic_one111111'),
    at: when(12),
  });
  registry.start({
    name: 'other',
    sid: 'cccccccc',
    kind: 'helper',
    task: 'a lookup',
    ...card('bl_notimplicit1'),
    at: when(13),
  });
  const [found, ...rest] = implicitCards(registry.agents());
  assert.equal(rest.length, 0, 'only ic_ ids are implicit cards');
  assert.equal(found.id, 'ic_one111111');
  assert.ok(found.title.length <= 80 + 3 && !found.title.includes('\n'));
  assert.equal(found.repo, 'acme/widgets');
  assert.equal(found.branch, 'later-branch', 'a later run fills the branch');
  assert.equal(found.sid, 'aaaaaaaa');
  assert.equal(found.agent, 'ou-a');
  assert.equal(found.runs.length, 3);
});

test('an adopted id drops out, and the items carry implicit and are live while a run is open', () => {
  const home = tmp('implicit-items');
  const registry = new AgentRegistry(home);
  registry.start({
    name: 'a',
    sid: 'aaaaaaaa',
    kind: 'helper',
    task: 'one',
    ...card('ic_one111111'),
    at: when(0),
  });
  registry.start({
    name: 'b',
    sid: 'aaaaaaaa',
    kind: 'helper',
    task: 'two',
    ...card('ic_two222222'),
    at: when(1),
  });
  registry.finish('b', { sid: 'aaaaaaaa', at: when(2) });
  const store = new BacklogStore(home);
  const items = implicitItems(registry.agents(), store.items());
  assert.deepEqual(
    items.map((one) => [one.id, one.implicit, one.state]),
    [
      ['ic_one111111', true, 'open'],
      ['ic_two222222', true, 'open'],
    ],
  );
  store.add({ id: 'ic_one111111', title: 'one' });
  assert.deepEqual(
    implicitItems(registry.agents(), store.items()).map((one) => one.id),
    ['ic_two222222'],
  );
});
