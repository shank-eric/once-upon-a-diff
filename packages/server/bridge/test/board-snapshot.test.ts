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
const { snapshots, finish, storedCardsChangeNothing } =
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
