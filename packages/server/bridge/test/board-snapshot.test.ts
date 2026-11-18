import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The /api/board answer for four fixture worlds, kept as golden JSON. A refactor of the board must leave them
// byte-identical. After a change that should alter the board, review the diff and rewrite them with:
//   UPDATE_SNAPSHOTS=1 node --test test/board-snapshot.test.ts
const golden = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/board-worlds/golden',
);
const { snapshots, finish, storedCardsChangeNothing, keeperChangesNothing } =
  await import('./fixtures/board-worlds/worlds.ts');
after(finish);

for (const [name, text] of Object.entries(snapshots)) {
  test(`board snapshot ${name}`, () => {
    const file = path.join(golden, `${name}.json`);
    if (process.env.UPDATE_SNAPSHOTS === '1') {
      mkdirSync(golden, { recursive: true });
      writeFileSync(file, text);
      return;
    }
    assert.equal(text, readFileSync(file, 'utf8'), `${name} differs from ${file}`);
  });
}

// ADR-29, branch A: a card stored for each source (what `agent start`, a session, a PR or a story writes) is read by nothing yet, so
// every world's board is the same with them in backlog.jsonl. A world whose runs name an `ic_` card keeps its implicit join.
test('stored cards of every source change no board', async () => {
  for (const [name, { before, after }] of Object.entries(await storedCardsChangeNothing())) {
    assert.equal(after, before, `${name}: the board changed when stored cards were added`);
  }
});

// ADR-29, branch B: the card keeper writes stored cards from what a build learned, and every world's board is the same with it on, built
// again (it writes nothing the second time). A started backlog card on a story's branch is in each world: it takes facts, not a change.
test('the card keeper changes no board, and writes nothing a second time', async () => {
  const worlds = Object.entries(await keeperChangesNothing());
  for (const [name, one] of worlds) {
    assert.equal(one.first, one.before, `${name}: the board changed when the keeper wrote`);
    assert.equal(one.second, one.before, `${name}: the board changed on the keeper's second build`);
    assert.equal(one.again, 0, `${name}: the keeper wrote again on an unchanged build`);
  }
  assert.ok(
    worlds.some(([, one]) => one.wrote > 0),
    'the keeper wrote a card in at least one world',
  );
});
