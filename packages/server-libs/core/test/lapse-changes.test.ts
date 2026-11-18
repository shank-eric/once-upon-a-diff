import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitChanges } from '../src/features/review/lapse-changes.ts';

const commit = (sha: string, subject: string) => ({ sha, at: '2026-11-01T10:00:00Z', subject });
/** Patch ids by sha; a sha not listed has the empty patch (null). */
const ids = (table: Record<string, string>) => (sha: string) => table[sha] ?? null;
const kinds = (result: ReturnType<typeof commitChanges>) =>
  result.changes.map((change) => [change.kind, change.subject]);

test('a rebase (new shas, same patches) and a reword change nothing', () => {
  const approved = [commit('b1', 'two'), commit('a1', 'one')];
  const now = [commit('b2', 'two, reworded'), commit('a2', 'one')];
  const idOf = ids({ a1: 'A', b1: 'B', a2: 'A', b2: 'B' });
  assert.deepEqual(commitChanges(approved, now, idOf), { changes: [], more: 0 });
});

test('an edited patch under the same subject is edited, with the approved sha', () => {
  const result = commitChanges(
    [commit('b1', 'two'), commit('a1', 'one')],
    [commit('b2', 'two'), commit('a2', 'one')],
    ids({ a1: 'A', b1: 'B', a2: 'A', b2: 'B2' }),
  );
  assert.deepEqual(result.changes, [{ kind: 'edited', sha: 'b2', subject: 'two', was: 'b1' }]);
});

test('a dropped commit names the approved one, an added commit the new one', () => {
  const idOf = ids({ a1: 'A', b1: 'B', a2: 'A', x: 'X' });
  assert.deepEqual(
    kinds(commitChanges([commit('b1', 'two'), commit('a1', 'one')], [commit('a2', 'one')], idOf)),
    [['dropped', 'two']],
  );
  const added = commitChanges(
    [commit('a1', 'one')],
    [commit('x', 'extra'), commit('a2', 'one')],
    idOf,
  );
  assert.deepEqual(added.changes, [{ kind: 'added', sha: 'x', subject: 'extra' }]);
});

test('a commit whose message and patch both changed is one dropped and one added', () => {
  const result = commitChanges(
    [commit('a1', 'one')],
    [commit('a2', 'uno')],
    ids({ a1: 'A', a2: 'A2' }),
  );
  assert.deepEqual(kinds(result), [
    ['added', 'uno'],
    ['dropped', 'one'],
  ]);
});

test('a swap reports one commit as reordered, not both', () => {
  const approved = [commit('c1', 'three'), commit('b1', 'two'), commit('a1', 'one')];
  const now = [commit('b2', 'two'), commit('c2', 'three'), commit('a2', 'one')];
  const result = commitChanges(
    approved,
    now,
    ids({ a1: 'A', b1: 'B', c1: 'C', a2: 'A', b2: 'B', c2: 'C' }),
  );
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.kind, 'reordered');
});

test('patch ids are asked only for commits whose sha is not on both sides', () => {
  const asked: string[] = [];
  const result = commitChanges(
    [commit('b1', 'two'), commit('a1', 'one')],
    [commit('x', 'extra'), commit('b1', 'two'), commit('a1', 'one')],
    (sha) => {
      asked.push(sha);
      return `id-${sha}`;
    },
  );
  assert.deepEqual(kinds(result), [['added', 'extra']]);
  assert.deepEqual(asked, ['x']);
});

test('equal patch ids pair one for one, and an untouched empty commit is unchanged', () => {
  const twice = commitChanges(
    [commit('a1', 'same'), commit('b1', 'same')],
    [commit('a2', 'same')],
    ids({ a1: 'S', b1: 'S', a2: 'S' }),
  );
  assert.deepEqual(kinds(twice), [['dropped', 'same']]);
  assert.deepEqual(commitChanges([commit('e1', 'empty')], [commit('e2', 'empty')], ids({})), {
    changes: [],
    more: 0,
  });
  // an empty commit that gained a patch is edited
  assert.deepEqual(
    kinds(commitChanges([commit('e1', 'wip')], [commit('e2', 'wip')], ids({ e2: 'E' }))),
    [['edited', 'wip']],
  );
});

test('at most 30 changes are kept, and the rest are counted', () => {
  const now = Array.from({ length: 40 }, (_, i) => commit(`n${i}`, `new ${i}`));
  const result = commitChanges([commit('a1', 'one')], now, ids({ a1: 'A' }));
  assert.equal(result.changes.length, 30);
  assert.equal(result.more, 11, '40 added and 1 dropped, 30 kept');
});
