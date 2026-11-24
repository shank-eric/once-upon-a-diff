import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { supersedeStoryteller } from '../src/features/runs/supersede.ts';

/*
 * supersedeStoryteller: a story re-told by a new agent (its binding moves from the old agent to the new one) finishes the
 * old agent's storyteller run if it is parked, as done, "superseded by <new>". A story is the unit, not the card.
 */

const SID = 'abcdef01';

function world() {
  const home = tmp('supersede-home');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'A card', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'feat-x', repo: 'acme/widgets' });
  const registry = new AgentRegistry(home);
  const tell = (name: string, state: 'running' | 'review' | 'waiting' = 'review', sid = SID) => {
    registry.start({
      name,
      sid,
      kind: 'storyteller',
      role: 'storyteller',
      card: item.id,
      task: 't',
    });
    if (state !== 'running') {
      registry.state(name, { sid, state, outcome: 'story ready' });
    }
  };
  const warnings: string[] = [];
  const supersede = (previous: string | null, next: string, session: string | null = null) =>
    supersedeStoryteller(home, previous ? { agent: previous, session } : null, next, (line) =>
      warnings.push(line),
    );
  const run = (name: string) => registry.agents().find((one) => one.name === name);
  return { tell, supersede, run, warnings };
}

test('a re-tell bound to the same story finishes the previous parked storyteller as superseded', () => {
  const ctx = world();
  ctx.tell('story-one');
  ctx.tell('story-two', 'running');
  ctx.supersede('story-one', 'story-two');
  assert.equal(ctx.run('story-one')?.state, 'done');
  assert.equal(ctx.run('story-one')?.outcome, 'superseded by story-two');
  assert.equal(ctx.run('story-two')?.state, 'running', 'the new run is left alone');
  assert.deepEqual(ctx.warnings, []);
});

test('two storytellers on one card bound to different stories are both left alone', () => {
  const ctx = world();
  ctx.tell('tell-a');
  ctx.tell('tell-b');
  // story B is re-told by tell-c: its previous binding named tell-b only
  ctx.tell('tell-c', 'running');
  ctx.supersede('tell-b', 'tell-c');
  assert.equal(ctx.run('tell-a')?.state, 'waiting', 'story A keeps its storyteller');
  assert.equal(ctx.run('tell-b')?.state, 'done');
  // a story with no earlier binding, or one bound to the same agent, supersedes nothing
  ctx.supersede(null, 'tell-c');
  ctx.supersede('tell-c', 'tell-c');
  assert.equal(ctx.run('tell-a')?.state, 'waiting');
  assert.equal(ctx.run('tell-c')?.state, 'running');
});

test('a previous storyteller still running is not superseded', () => {
  const ctx = world();
  ctx.tell('story-one', 'running');
  ctx.tell('story-two', 'running');
  ctx.supersede('story-one', 'story-two');
  assert.equal(ctx.run('story-one')?.state, 'running');
});

test('a storyteller named over 40 characters still supersedes the previous parked storyteller', () => {
  const ctx = world();
  const longName = `story-${'a'.repeat(50)}`;
  ctx.tell('story-one');
  ctx.supersede('story-one', longName);
  assert.equal(ctx.run('story-one')?.state, 'done');
  assert.equal(ctx.run('story-one')?.outcome, `superseded by ${longName}`);
  assert.deepEqual(ctx.warnings, []);
});

test('a parked storyteller of the same name in another session is left alone', () => {
  const ctx = world();
  ctx.tell('story-one'); // this session's (SID)
  // the binding's session is the full id, of which a run's sid is the front
  ctx.supersede('story-one', 'story-two', `${SID}-0000-4000-8000-000000000000`);
  assert.equal(ctx.run('story-one')?.state, 'done');

  const other = world();
  other.tell('story-one', 'review', '99887766'); // another session's run of the reused name
  other.supersede('story-one', 'story-two', `${SID}-0000-4000-8000-000000000000`);
  assert.equal(other.run('story-one')?.state, 'waiting');
  assert.deepEqual(other.warnings, []);
});
