/*
 * Restated rules (scripts/restated-rules.ts): a condition written out where an exported predicate already names it. The normalizer
 * folds spellings, the matcher looks them up in an index of the repo's predicates, and only conditions on the diff's added lines
 * count. The last tests run --all over a fixture with known restatements, and over the real repo only to see that it runs and reports a count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import typescript from 'typescript';
import { git } from '@once-upon-a-diff/test-kit/git';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { PACKAGES, TIERS } from '../../../../configs/layers.mjs';
import { restatedRules, report } from '../scripts/restated-rules.ts';
import { addedLines } from '../scripts/lib/diff.ts';
import { ENGINE, TIERED, canCall, placeOf } from '../scripts/lib/layers.ts';
import { normalize } from '../scripts/lib/normalize.ts';
import { indexSource } from '../scripts/lib/predicates.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The normalized form of an expression written as source, about the value `subject`. */
function norm(code: string, subject: string): string {
  const source = typescript.createSourceFile(
    'x.ts',
    `const x = ${code};`,
    typescript.ScriptTarget.Latest,
    true,
  );
  const [statement] = source.statements;
  assert.ok(statement && typescript.isVariableStatement(statement));
  return normalize(statement.declarationList.declarations[0]!.initializer!, subject);
}

test('the normalizer reads one condition the same under another name, order, cast or bang', () => {
  const same = (one: [string, string], two: [string, string]) =>
    assert.equal(norm(...one), norm(...two), `${one[0]}  vs  ${two[0]}`);
  same(
    [`agent.state === 'failed' && !!agent.acked`, 'agent'],
    [`run.acked && run.state === 'failed'`, 'run'],
  );
  same([`!!x.ok`, 'x'], [`x.ok`, 'x']);
  same([`x?.ok`, 'x'], [`x.ok`, 'x']);
  same([`(a as string) === "k"`, 'a'], [`'k' === a`, 'a']);
  same([`END.includes(state as string)`, 'state'], [`END.includes(state)`, 'state']);
  same([`(a && b) && c`, 'a'], [`c && (b && a)`, 'a']);
});

test('the normalizer folds a !== b into the negation of a === b, and keeps a ?? b apart from a || b', () => {
  assert.equal(norm(`item.source !== 'x'`, 'item'), `!(${norm(`item.source === 'x'`, 'item')})`);
  assert.notEqual(norm(`item.source ?? 'x'`, 'item'), norm(`item.source || 'x'`, 'item'));
  assert.notEqual(norm(`a.x && a.y`, 'a'), norm(`a.x || a.y`, 'a'));
  assert.notEqual(norm(`a.x === 1`, 'a'), norm(`a.x === 2`, 'a'));
});

const PREDICATES = `
export const isListed = (item: { source?: string }): boolean => (item.source ?? 'backlog') === 'backlog';
export const isAcked = (agent: { state: string; acked?: string }): boolean => agent.state === 'failed' && !!agent.acked;
export const isCritic = (agent: { kind?: string }): boolean => agent.kind === 'critic';
export const isFinished = (agent: { state: string }): boolean => isEndState(agent.state);
export const isEndState = (state: string): boolean => (END as readonly string[]).includes(state);
export const kindOf = (agent: { kind: string }) => agent.kind;
export const isNamed = (agent: { name: string }): boolean => !agent.name;
export function isTwo(agent: { n: number }): boolean {
  const n = agent.n;
  return n === 2;
}
export function isOne(agent: { n: number }): boolean {
  return agent.n === 1 && agent.n !== 2;
}
export const isShipped = (card: { skips: boolean; deploy: string }): boolean =>
  !(card.skips || card.deploy === 'local');
const isPrivate = (agent: { a: string }): boolean => agent.a === 'a' && agent.a !== 'b';
`;

test('the index holds the exported one-parameter single-expression rules, not wrappers, reads or multi-statement bodies', () => {
  const index = indexSource('packages/server-libs/state/src/p.ts', PREDICATES);
  const names = [...index.values()].flat().map((one) => one.name);
  assert.deepEqual(names.sort(), [
    'isAcked',
    'isCritic',
    'isEndState',
    'isListed',
    'isOne',
    'isShipped',
  ]);
  const critic = [...index.values()].flat().find((one) => one.name === 'isCritic');
  assert.equal(critic?.note, true, 'a single comparison is a note');
  assert.equal([...index.values()].flat().find((one) => one.name === 'isAcked')?.note, false);
  assert.equal(
    indexSource('packages/client/web/public/p.ts', PREDICATES).size,
    0,
    'only the engine and the domain are indexed',
  );
});

/** A repo with the predicates at base, then one commit adding `added` to a file in `consumer`'s package; returns the diff's report. */
function restated(
  added: string,
  consumer = 'packages/server-libs/board/src/use.ts',
  untouched = '',
): ReturnType<typeof restatedRules> {
  const root = tmp('restated');
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  git(root, 'init', '-q', '-b', 'main');
  put('packages/server-libs/state/src/p.ts', PREDICATES);
  put(consumer, `export const keep = 1;\n${untouched}`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  put(consumer, `export const keep = 1;\n${untouched}${added}`);
  git(root, 'commit', '-q', '-am', 'add');
  return restatedRules(root, git(root, 'diff', '-U0', 'main~1...HEAD'));
}

test('a condition added in the diff that restates a rule is a hit at its file and line, naming the rule to call', () => {
  const { hits, notes } = restated(
    `const a = (run: any) => run.state === 'failed' && !!run.acked;\n`,
  );
  assert.equal(notes.length, 0);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.predicate, 'isAcked');
  assert.equal(hits[0]?.file, 'packages/server-libs/board/src/use.ts');
  assert.equal(hits[0]?.line, 2);
  assert.match(
    report({ read: true, hits, notes }),
    /use\.ts:2 {2}".*" restates isAcked \(.*p\.ts:\d+\): call isAcked\(\.\.\.\)\nrestated rules: 1/,
  );
});

test('the same condition left untouched in the base gives no hit', () => {
  const line = `const a = (run: any) => run.state === 'failed' && !!run.acked;\n`;
  const { hits } = restated(`export const b = 1;\n`, undefined, line);
  assert.deepEqual(hits, []);
});

test('negated forms are hits on the negated rule, and a bare parameter works', () => {
  const found = restated(
    `const a = (card: any) => (card.source ?? 'backlog') !== 'backlog';\nconst b = (s: string) => !(END as readonly string[]).includes(s);\n`,
  );
  assert.deepEqual(
    found.hits.map((hit) => [hit.predicate, hit.negated]),
    [
      ['isListed', true],
      ['isEndState', true],
    ],
  );
});

test('a rule whose body is a negation is hit as written, and its positive form is the negated hit', () => {
  const found = restated(
    `const a = (card: any) => !(card.skips || card.deploy === 'local');\nconst b = (card: any) => card.skips || card.deploy === 'local';\n`,
  );
  assert.deepEqual(
    found.hits.map((hit) => [hit.predicate, hit.line, hit.negated]),
    [
      ['isShipped', 2, false],
      ['isShipped', 3, true],
    ],
  );
});

test('a negated chain is one hit, on the negated rule, not also a positive hit on its inner chain', () => {
  const found = restated(`const a = (run: any) => !(run.state === 'failed' && !!run.acked);\n`);
  assert.deepEqual(
    found.hits.map((hit) => [hit.predicate, hit.negated]),
    [['isAcked', true]],
  );
});

test('a single comparison is a note, and the half of a longer condition is a note, not a rule hit', () => {
  const { hits, notes } = restated(
    `const a = (x: any) => x.kind === 'critic';\nconst b = (x: any) => x.kind === 'critic' || x.role === 'critic';\n`,
  );
  assert.deepEqual(hits, []);
  assert.deepEqual(
    notes.map((note) => [note.predicate, note.line]),
    [
      ['isCritic', 2],
      ['isCritic', 3],
    ],
  );
});

test('a contiguous part of a longer chain is a hit, an extra operand elsewhere is not an exact match', () => {
  const part = restated(
    `const a = (r: any) => r.ok && r.state === 'failed' && !!r.acked && r.more;\n`,
  );
  assert.deepEqual(
    part.hits.map((hit) => hit.predicate),
    ['isAcked'],
  );
  const other = restated(`const a = (r: any) => r.state === 'failed' && !!r.acked2;\n`);
  assert.deepEqual(other.hits, []);
});

test('the layers keep the advice honest: no hit where the file may not import the rule', () => {
  const line = `const a = (run: any) => run.state === 'failed' && !!run.acked;\n`;
  assert.deepEqual(
    restated(line, 'packages/server-libs/foundation/src/use.ts').hits,
    [],
    'foundation sits under state',
  );
  assert.deepEqual(
    restated(line, 'packages/client/web/public/use.ts').hits,
    [],
    'a client file cannot import a server rule',
  );
  assert.equal(
    restated(line, 'packages/server-libs/core/src/features/x/use.ts').hits.length,
    1,
    'core sits over state',
  );
  assert.deepEqual(
    restated(line, 'packages/server-libs/state/src/p.ts').hits,
    [],
    'a rule written in its own definition is not a restatement',
  );
});

test('an app is not advised an adapters rule, and the shell and the cli are not advised a board rule', () => {
  const index = indexSource('packages/server-libs/adapters/src/p.ts', PREDICATES);
  const rule = [...index.values()].flat().find((one) => one.name === 'isAcked');
  assert.ok(rule);
  assert.equal(canCall(rule.place, placeOf('packages/server/server/src/routes/x.ts')!), false);
  assert.equal(canCall(rule.place, placeOf('packages/server/cli/src/x.ts')!), false);
  assert.equal(canCall(rule.place, placeOf('packages/server/bridge/bin/x.ts')!), true);
  const board = placeOf('packages/server-libs/board/src/x.ts')!;
  assert.equal(canCall(board, placeOf('packages/server/server/src/x.ts')!), true);
  assert.equal(canCall(board, placeOf('packages/server/cli/src/x.ts')!), false);
  assert.equal(canCall(board, placeOf('packages/server/bridge/bin/x.ts')!), false);
});

test('the diff reader reads a prefix-less path, and says nothing was read for an empty or non-diff input', () => {
  const none = restatedRules(ROOT, 'not a diff');
  assert.equal(none.read, false);
  assert.match(report(none), /no diff read/);
  assert.deepEqual(
    [...addedLines('+++ x.ts\n@@ -1 +1 @@\n+a\n')],
    [['x.ts', [[1, 1]]]],
    'diff.noprefix writes the path bare',
  );
  assert.equal(restated(`export const b = 1;\n`).read, true);
});

test('the diff reader gives the added lines by the new path, and nothing for a deleted file or a pure deletion', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -3,0 +4,2 @@',
    '+a',
    '@@ -9 +11 @@',
    '-b',
    '@@ -20,2 +22,0 @@',
    'diff --git a/gone.ts b/gone.ts',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
  ].join('\n');
  assert.deepEqual(
    [...addedLines(diff)],
    [
      [
        'x.ts',
        [
          [4, 5],
          [11, 11],
        ],
      ],
    ],
  );
});

test('the layer order and tiers here are the ones in configs/layers.mjs', () => {
  assert.deepEqual(ENGINE, PACKAGES);
  assert.deepEqual(TIERED, TIERS);
});

test('--all over a repo with known restatements finds 3 of isListed (one negated) and 1 of isEndState, and skips test files', () => {
  const root = tmp('restated-all');
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  git(root, 'init', '-q', '-b', 'main');
  put('packages/server-libs/state/src/p.ts', PREDICATES);
  put(
    'packages/server-libs/board/src/use.ts',
    [
      `const a = (card: any) => (card.source ?? 'backlog') === 'backlog';`,
      `const b = (item: any) => (item.source ?? 'backlog') === 'backlog';`,
      `const c = (card: any) => (card.source ?? 'backlog') !== 'backlog';`,
      `const d = (s: string) => (END as readonly string[]).includes(s);`,
      '',
    ].join('\n'),
  );
  put(
    'packages/server-libs/board/test/use.test.ts',
    `const e = (card: any) => (card.source ?? 'backlog') === 'backlog';\n`,
  );
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  const { hits } = restatedRules(root, null);
  const named = (name: string) => hits.filter((hit) => hit.predicate === name);
  assert.equal(named('isListed').length, 3);
  assert.equal(named('isListed').filter((hit) => hit.negated).length, 1);
  assert.equal(named('isEndState').length, 1);
  assert.ok(
    hits.every((hit) => !/\/test\//.test(hit.file)),
    'tests restate on purpose and are skipped',
  );
});

test('over the real repo, --all runs, reads the repo, and reports a count', () => {
  const result = restatedRules(ROOT, null);
  assert.equal(result.read, true);
  assert.ok(Array.isArray(result.hits));
  assert.match(report(result), /restated rules: \d+/);
});
