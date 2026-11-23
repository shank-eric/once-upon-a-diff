import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, writeJson } from './helpers.ts';
import { resolveStory } from '@once-upon-a-diff/core/features/listeners/story-ref';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { stateKeyOf } from '@once-upon-a-diff/stories/meta';

// ADR-29: a card id is accepted wherever a story id is. `--story bl_...` is the story the card holds, so a question asked against
// the card lands in the same inbox story and `state/` folder as one asked against the story.
function world() {
  const home = tmp('key-by-card-home');
  writeJson(path.join(home, 'config.json'), {});
  writeJson(path.join(home, 'local-told', 'meta.json'), { kind: 'local', repo_name: 'widgets' });
  writeJson(path.join(home, 'local-told', 'chapters.json'), { title: 'T', chapters: [] });
  const backlog = new BacklogStore(home);
  const holds = backlog.add({ title: 'holds a story', repo: 'acme/widgets' });
  backlog.link(holds.id, { story: 'local-told' });
  const bare = backlog.add({ title: 'no story yet', repo: 'acme/widgets' });
  return { home, holds: holds.id, bare: bare.id };
}

test('--story takes a card id: the story the card holds, with the same state key as the story’s own id', () => {
  const { home, holds } = world();
  const found = resolveStory(home, holds, () => null);
  assert.equal(found, 'local-told');
  const meta = { kind: 'local' } as never;
  assert.equal(stateKeyOf(found, meta), stateKeyOf('local-told', meta));
});

test('--story with a card that has no story says so, and an id no card has is left as a story id', () => {
  const { home, bare } = world();
  assert.throws(() => resolveStory(home, bare, () => null), /that card has no story yet/);
  assert.equal(
    resolveStory(home, 'bl_nosuchcard1', () => null),
    'bl_nosuchcard1',
  );
  assert.equal(
    resolveStory(home, 'local-told', () => null),
    'local-told',
  );
});
