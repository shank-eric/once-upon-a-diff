/*
 * Every `path:N` (or `path:N-M`) in README.md, docs/*.md and docs/adr/*.md must point at a real line. The path is from the repo root. When the
 * reference is followed by the name found on that line, `` `path:N` (`name`) ``, the line (or one of the lines of a range) must contain
 * it, so a line that moved to another place fails here instead of misleading a reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCS = path.join(ROOT, 'docs');

const REF =
  /([A-Za-z0-9_.@/-]+\.(?:ts|tsx|mjs|js|json|md|sh|css|yml)):(\d+)(?:[-–](\d+))?`?( \(`(.+?)`\))?/g;

type DocRef = {
  doc: string;
  line: number;
  file: string;
  from: number;
  to: number;
  name: string | null;
};

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return markdownFiles(full);
    }
    return full.endsWith('.md') ? [full] : [];
  });
}

function docRefs(): DocRef[] {
  const refs: DocRef[] = [];
  for (const doc of [path.join(ROOT, 'README.md'), ...markdownFiles(DOCS)]) {
    readFileSync(doc, 'utf8')
      .split('\n')
      .forEach((text, index) => {
        for (const found of text.matchAll(REF)) {
          const from = Number(found[2]);
          refs.push({
            doc: path.relative(ROOT, doc),
            line: index + 1,
            file: found[1]!,
            from,
            to: found[3] ? Number(found[3]) : from,
            name: found[5] ?? null,
          });
        }
      });
  }
  return refs;
}

const spelled = (ref: DocRef) => `${ref.file}:${ref.from}${ref.to > ref.from ? `-${ref.to}` : ''}`;

/** What is wrong with one reference, or null. */
function refProblem(ref: DocRef): string | null {
  const full = path.join(ROOT, ref.file);
  if (!existsSync(full)) {
    return `${ref.file} does not exist`;
  }
  const lines = readFileSync(full, 'utf8').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  if (ref.from < 1 || ref.to < ref.from) {
    return `${ref.from}-${ref.to} is not a line range`;
  }
  if (ref.to > lines.length) {
    return `${ref.file} has ${lines.length} lines, the reference says ${ref.to}`;
  }
  const { name } = ref;
  if (name && !lines.slice(ref.from - 1, ref.to).some((text) => text.includes(name))) {
    return `no \`${name}\` on ${spelled(ref)}`;
  }
  return null;
}

test('the docs have file:line references to check', () => {
  assert.ok(docRefs().length > 100, `only ${docRefs().length} references found`);
});

test('every file:line reference in docs/ points at a real line that holds the name beside it', () => {
  const broken = docRefs()
    .map((ref) => ({ ref, problem: refProblem(ref) }))
    .filter((one) => one.problem)
    .map(({ ref, problem }) => `${ref.doc}:${ref.line}  ${spelled(ref)}  ${problem}`);
  assert.deepEqual(broken, [], `${broken.length} broken references in docs/`);
});

test('the checker catches a missing file, a line past the end and a name that is not on the line', () => {
  const good = { doc: 'x', line: 1, file: 'package.json', from: 1, to: 1, name: null };
  assert.equal(refProblem(good), null);
  assert.match(refProblem({ ...good, file: 'nope/missing.ts' })!, /does not exist/);
  assert.match(refProblem({ ...good, from: 9999, to: 9999 })!, /has \d+ lines/);
  assert.match(refProblem({ ...good, name: 'no such text on line one' })!, /no `no such text/);
  assert.equal(refProblem({ ...good, to: 3, name: 'workspace' }), null);
});
