/*
 * The live docs (README.md, AGENTS.md, every docs/*.md and ADR-26) cite code by file and name, `` `path/to/file.ts` (`name`) ``, never by
 * line, so a line that moves breaks nothing. Each cited file must exist (a short path like state-map's `board/src/board.ts` must resolve to
 * exactly one file), and each name beside it must be declared there: a function, const, class, type, method or key, or an import. A name that
 * is not a plain identifier (a call such as `app.board.snapshot(`, or `v: 1`) must be in the file as written. A cite form the test cannot read
 * fails; it is never skipped. Every `packages/...` path the docs mention must exist. The other ADRs are history: they say at the top that
 * their paths are as of their date, and are not read here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The live docs: README.md, AGENTS.md, every docs/*.md (a new one is live at once) and ADR-26. The other ADRs are history. */
function liveDocs(root: string): string[] {
  const docs = readdirSync(path.join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`);
  return ['README.md', 'AGENTS.md', ...docs.sort(), 'docs/adr/adr-26-the-data-model.md'];
}

const EXT = 'ts|tsx|mjs|js|json|md|sh|css|yml';
const CODE_EXT = /\.(?:ts|tsx|mjs|js)$/;
const SHORT_PATH_DOC = 'docs/state-map.md';
const TOP_FOLDERS = ['packages', 'scripts', 'skills', 'docs', 'configs', 'agents', 'extras'];
// A backticked repo file: `dir/file.ext`. What follows it, on the same line, says what to look for in it.
const PATH_TOKEN = new RegExp(`\`([A-Za-z0-9_.@-][A-Za-z0-9_.@/-]*\\.(?:${EXT}))\``, 'g');
// ` (`a`, `b`)`: one or more backticked names in parentheses after the path.
const NAMES_IN_PARENS = /^ \((`[^`]+`(?:(?:, | and | or )`[^`]+`)*)\)/;
// ` `name`, `other``: bare symbol names right after a path (state-map's tables).
const BARE_NAMES = /^ (`[A-Za-z_$][\w$]*`(?:, `[A-Za-z_$][\w$]*`)*)/;
const LINE_CITE = new RegExp(`[A-Za-z0-9_.@/-]+\\.(?:${EXT}):\\d+`, 'g');
const PACKAGE_PATH = /packages\/[A-Za-z0-9_./-]+/g;
// Made by a build or a test run, so not in a fresh checkout.
const MADE_BY_RUNS = /\/(?:\.output|test-results)(?:\/|$)/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// Words that sit in every file: a cite naming one can never fail, so it must name a real symbol instead.
const WEAK_NAMES = new Set(
  `break case catch class const continue default delete do else enum export extends false finally for function if import in
  instanceof interface let new null of return static super switch this throw true try type typeof var void while with yield await async
  v action start done run send items snapshot request update`.split(/\s+/),
);

type Cite = { doc: string; line: number; file: string; names: string[]; problem: string | null };

/** The cites on one line of a doc. A cite form that cannot be read comes back with a `problem`, so it fails instead of being skipped. */
function citesIn(doc: string, text: string, root: string): Cite[] {
  const names = packageNames(root);
  return text.split('\n').flatMap((lineText, index) =>
    [...lineText.matchAll(PATH_TOKEN)].flatMap((found) => {
      const file = found[1]!;
      const first = file.split('/')[0]!;
      const isShort = !TOP_FOLDERS.includes(first);
      // Short paths are state-map's own convention (its intro); other docs write paths relative to the package they are describing.
      // A short `.json` is a runtime file (`usage/actions.json`), not a repo file.
      if (
        isShort &&
        (doc !== SHORT_PATH_DOC || !(names.has(first) || first === 'adr') || file.endsWith('.json'))
      ) {
        return [];
      }
      const tail = lineText.slice(found.index + found[0].length);
      const cite: Cite = { doc, line: index + 1, file, names: [], problem: null };
      const inParens = tail.match(NAMES_IN_PARENS);
      const bare = CODE_EXT.test(file) ? tail.match(BARE_NAMES) : null;
      if (inParens) {
        cite.names = [...inParens[1]!.matchAll(/`([^`]+)`/g)].map((one) => one[1]!);
      } else if (tail.startsWith(' (`')) {
        cite.problem =
          'a cite form the test cannot read: write (`name`, `other`) right after the path';
      } else if (bare) {
        cite.names = [...bare[1]!.matchAll(/`([^`]+)`/g)].map((one) => one[1]!);
      }
      return [cite];
    }),
  );
}

function liveCites(): Cite[] {
  return liveDocs(ROOT).flatMap((doc) =>
    citesIn(doc, readFileSync(path.join(ROOT, doc), 'utf8'), ROOT),
  );
}

/** Folder names of the packages and their groups: `board`, `core`, `domain`, `server`... */
function packageNames(root: string): Set<string> {
  const found = new Set<string>();
  const packages = path.join(root, 'packages');
  if (!existsSync(packages)) {
    return found;
  }
  for (const group of readdirSync(packages, { withFileTypes: true }).filter((one) =>
    one.isDirectory(),
  )) {
    found.add(group.name);
    for (const one of readdirSync(path.join(packages, group.name), { withFileTypes: true })) {
      if (one.isDirectory()) {
        found.add(one.name);
      }
    }
  }
  return found;
}

/** The one file a cited path means: a full path, or state-map's short path (`board/src/board.ts`, `core/src/...`, `adr/...`). */
function resolveFile(root: string, file: string): { full: string } | { problem: string } {
  const first = file.split('/')[0]!;
  if (TOP_FOLDERS.includes(first)) {
    const full = path.join(root, file);
    return existsSync(full) ? { full } : { problem: `${file} does not exist` };
  }
  const rest = file.split('/').slice(1).join('/');
  const found = new Set<string>();
  const packages = path.join(root, 'packages');
  const groups = existsSync(packages) ? readdirSync(packages) : [];
  const tries = [
    path.join('packages', file), // `domain/terms/src/parts.ts`
    path.join('docs', file), // `adr/adr-01-....md`
    ...groups.flatMap((group) => [
      path.join('packages', group, file), // `board/src/board.ts`
      path.join('packages', group, first, 'src', rest), // `core/features/...`, `server/routes/story.ts`
    ]),
  ];
  for (const one of tries) {
    if (existsSync(path.join(root, one)) && !statSync(path.join(root, one)).isDirectory()) {
      found.add(one);
    }
  }
  if (found.size === 0) {
    return { problem: `${file} matches no file under packages/*/ or docs/` };
  }
  if (found.size > 1) {
    return { problem: `${file} matches ${found.size} files: ${[...found].join(', ')}` };
  }
  return { full: path.join(root, [...found][0]!) };
}

/** Whether `name` is in `source`: a word match where the name starts or ends on a word character. */
function holds(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const edge = (char: string | undefined) => (char && /\w/.test(char) ? '\\b' : '');
  return new RegExp(`${edge(name[0])}${escaped}${edge(name.at(-1))}`).test(source);
}

/** Whether `name` is declared in a TypeScript or JavaScript file: a function, const, let, var, class, type, interface or enum; a method or
 * object key at the start of a line; or an import. A simple set of patterns, no parsing. */
function declaredInCode(source: string, name: string): boolean {
  const id = name.replace(/\$/g, '\\$');
  return [
    new RegExp(`\\b(?:function\\*?|const|let|var|class|type|interface|enum|namespace)\\s+${id}\\b`),
    new RegExp(
      `^[ \\t]*(?:(?:export|default|declare|public|private|protected|static|readonly|abstract|override|async|get|set)\\s+)*${id}\\s*[?!]?\\s*(?:<[^\\n]*>)?\\s*[(:=]`,
      'm',
    ),
    new RegExp(`^[ \\t]*['"]${id}['"]\\s*:`, 'm'),
    new RegExp(`^import\\b[^;]*?\\b${id}\\b[^;]*?\\bfrom\\b`, 'm'),
  ].some((pattern) => pattern.test(source));
}

/** What is wrong with one name cited for a file, or null. A plain identifier must be declared there (not a keyword or a word every file has);
 * anything else (`app.board.snapshot(`, `v: 1`, `'Index-only stories'`) is a snippet and must be in the file as written. */
function nameProblem(source: string, file: string, name: string): string | null {
  if (!IDENTIFIER.test(name)) {
    return holds(source, name) ? null : `no \`${name}\` in ${file}`;
  }
  if (WEAK_NAMES.has(name) || name.length < 3) {
    return `\`${name}\` is in every file: cite the function, class, const or type it is in, or the call as written`;
  }
  if (file.endsWith('.json')) {
    return new RegExp(`"${name}"\\s*:`).test(source) ? null : `no key \`${name}\` in ${file}`;
  }
  if (file.endsWith('.sh')) {
    const shell = [
      `^\\s*(?:function\\s+)?${name}\\s*\\(\\)`,
      `^\\s*(?:export\\s+|local\\s+|readonly\\s+)?${name}=`,
    ];
    return shell.some((pattern) => new RegExp(pattern, 'm').test(source))
      ? null
      : `\`${name}\` is not declared in ${file}`;
  }
  if (!CODE_EXT.test(file)) {
    return holds(source, name) ? null : `no \`${name}\` in ${file}`;
  }
  return declaredInCode(source, name)
    ? null
    : `\`${name}\` is in ${file} but not declared there (a function, const, class, type, method or key)`;
}

/** What is wrong with one cite, or null. */
function citeProblem(cite: Cite, root: string): string | null {
  if (cite.problem) {
    return cite.problem;
  }
  const resolved = resolveFile(root, cite.file);
  if ('problem' in resolved) {
    return resolved.problem;
  }
  const source = readFileSync(resolved.full, 'utf8');
  for (const name of cite.names) {
    const problem = nameProblem(source, cite.file, name);
    if (problem) {
      return problem;
    }
  }
  return null;
}

test('the live docs have file and name cites to check', () => {
  assert.ok(liveCites().length > 100, `only ${liveCites().length} cites found`);
  assert.ok(
    liveCites().some((cite) => cite.doc === 'docs/state-map.md' && cite.names.length > 0),
    'no state-map cite with a name',
  );
});

test('every cite in the live docs names a file that exists and declares the names beside it', () => {
  const broken = liveCites()
    .map((cite) => ({ cite, problem: citeProblem(cite, ROOT) }))
    .filter((one) => one.problem)
    .map(({ cite, problem }) => `${cite.doc}:${cite.line}  ${cite.file}  ${problem}`);
  assert.deepEqual(broken, [], `${broken.length} broken cites`);
});

test('the live docs cite no line numbers', () => {
  const lined = liveDocs(ROOT).flatMap((doc) =>
    readFileSync(path.join(ROOT, doc), 'utf8')
      .split('\n')
      .flatMap((text, index) =>
        [...text.matchAll(LINE_CITE)].map((found) => `${doc}:${index + 1}  ${found[0]}`),
      ),
  );
  assert.deepEqual(lined, [], 'cite a file and a name, not a line');
});

test('every packages/ path in the live docs exists', () => {
  const dead = liveDocs(ROOT).flatMap((doc) =>
    readFileSync(path.join(ROOT, doc), 'utf8')
      .split('\n')
      .flatMap((text, index) =>
        [...text.matchAll(PACKAGE_PATH)]
          .map((found) => found[0].replace(/[.:,]+$/, ''))
          .filter((found) => !MADE_BY_RUNS.test(found) && !existsSync(path.join(ROOT, found)))
          .map((found) => `${doc}:${index + 1}  ${found}`),
      ),
  );
  assert.deepEqual(dead, [], `${dead.length} paths that do not exist`);
});

/** A throwaway repo with the files given, and the problem (or null) of the first cite in `line`. */
function problemOf(files: Record<string, string>, line: string, doc = 'doc.md'): string | null {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-refs-'));
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), source);
  }
  const [cite] = citesIn(doc, line, root);
  assert.ok(cite, `no cite read from: ${line}`);
  return citeProblem(cite, root);
}

test('a cite still passes when lines are added above its name, and fails when the file or the name goes', () => {
  const source = 'export function diffText() {}\n';
  const line = 'Reads it in `packages/x/git.ts` (`diffText`).';
  assert.equal(problemOf({ 'packages/x/git.ts': source }, line), null);
  assert.equal(
    problemOf({ 'packages/x/git.ts': `${'// a line\n'.repeat(10)}${source}` }, line),
    null,
  );
  assert.match(
    problemOf({ 'packages/x/git.ts': 'export function diffTextOld() {}\n' }, line)!,
    /not declared/,
  );
  assert.match(problemOf({ 'packages/x/other.ts': source }, line)!, /does not exist/);
});

test('a name that is in the file but not declared there fails', () => {
  const line = 'See `packages/x/git.ts` (`diffText`).';
  const callsOnly =
    'import { run } from "./run";\nexport function other() {\n  return run(diffText);\n}\n';
  assert.match(
    problemOf({ 'packages/x/git.ts': callsOnly }, line)!,
    /`diffText` is in packages\/x\/git\.ts but not declared/,
  );
  for (const declared of [
    'export function diffText() {}',
    'export const diffText = 1;',
    'export type diffText = string;',
    'class A {\n  private async diffText(): Promise<void> {}\n}',
    'const x = {\n  diffText: 1,\n};',
    'import { diffText } from "./git";',
  ]) {
    assert.equal(problemOf({ 'packages/x/git.ts': declared }, line), null, declared);
  }
});

test('a keyword or a word every file has is refused even where it is declared', () => {
  for (const word of ['for', 'if', 'v', 'action', 'type', 'start', 'done']) {
    const problem = problemOf(
      { 'packages/x/git.ts': `const ${word} = 1;\nfor (const a of b) {}\n` },
      `See \`packages/x/git.ts\` (\`${word}\`).`,
    );
    assert.match(problem!, /is in every file/, word);
  }
});

test('a name that is not an identifier must be in the file as written', () => {
  const files = {
    'packages/x/git.ts': 'const line = { v: 1, ...event };\nreturn app.board.snapshot();\n',
  };
  assert.equal(problemOf(files, 'See `packages/x/git.ts` (`v: 1`).'), null);
  assert.equal(problemOf(files, 'See `packages/x/git.ts` (`app.board.snapshot(`).'), null);
  assert.match(
    problemOf(files, 'See `packages/x/git.ts` (`app.board.type(`).')!,
    /no `app.board.type\(` in/,
  );
});

test('a short path resolves to exactly one file under packages/*/', () => {
  const board = {
    'packages/server-libs/board/src/board.ts': 'export function listeningNow() {}\n',
  };
  assert.equal(
    problemOf(board, 'See `board/src/board.ts` (`listeningNow`).', SHORT_PATH_DOC),
    null,
  );
  assert.equal(problemOf(board, 'See `board/src/board.ts` `listeningNow`.', SHORT_PATH_DOC), null);
  assert.match(
    problemOf(board, 'See `board/src/gone.ts` (`listeningNow`).', SHORT_PATH_DOC)!,
    /matches no file/,
  );
  assert.match(
    problemOf(board, 'See `board/src/board.ts` (`listeningThen`).', SHORT_PATH_DOC)!,
    /not declared/,
  );
  assert.match(
    problemOf(board, 'See `board/src/board.ts` `listeningThen`.', SHORT_PATH_DOC)!,
    /not declared/,
  );
  const twice = {
    ...board,
    'packages/client/board/src/board.ts': 'export function listeningNow() {}\n',
  };
  assert.match(
    problemOf(twice, 'See `board/src/board.ts` (`listeningNow`).', SHORT_PATH_DOC)!,
    /matches 2 files/,
  );
  assert.deepEqual(
    citesIn('README.md', 'See `board/src/gone.ts` (`listeningNow`).', ROOT),
    [],
    'short paths are read in state-map only',
  );
  // `core/features/x.ts` is `packages/server-libs/core/src/features/x.ts`
  assert.equal(
    problemOf(
      { 'packages/server-libs/core/src/features/x.ts': 'export const value = 1;\n' },
      'See `core/features/x.ts` (`value`).',
      SHORT_PATH_DOC,
    ),
    null,
  );
});

test('every name in a cite that lists several is checked', () => {
  const files = { 'packages/x/git.ts': 'export function alpha() {}\nexport function beta() {}\n' };
  assert.equal(problemOf(files, 'See `packages/x/git.ts` (`alpha`, `beta`).'), null);
  assert.equal(problemOf(files, 'See `packages/x/git.ts` (`alpha` and `beta`).'), null);
  assert.match(
    problemOf(files, 'See `packages/x/git.ts` (`alpha`, `gamma`).')!,
    /`gamma` is in packages\/x\/git\.ts but not declared/,
  );
  assert.match(problemOf(files, 'See `packages/x/git.ts` (`gamma`, `alpha`).')!, /`gamma`/);
  assert.match(problemOf(files, 'See `packages/x/git.ts` `alpha`, `gamma`.')!, /`gamma`/);
});

test('a cite form the test cannot read fails instead of being skipped', () => {
  const files = { 'packages/x/git.ts': 'export function alpha() {}\n' };
  assert.match(
    problemOf(files, 'See `packages/x/git.ts` (`alpha` and then some words).')!,
    /cannot read/,
  );
  assert.match(problemOf(files, 'See `packages/x/git.ts` (`alpha`, then `beta`).')!, /cannot read/);
});

test('every docs/*.md is a live doc, and the ADRs other than ADR-26 are not', () => {
  const docs = liveDocs(ROOT);
  assert.ok(
    docs.includes('docs/flows.md') &&
      docs.includes('docs/state-map.md') &&
      docs.includes('docs/adr/adr-26-the-data-model.md'),
  );
  assert.ok(!docs.some((doc) => /adr-(?!26)/.test(doc)));
  const root = mkdtempSync(path.join(tmpdir(), 'doc-refs-'));
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs/new-doc.md'), '');
  assert.ok(liveDocs(root).includes('docs/new-doc.md'));
});

test('a name with punctuation at its edge is found as written', () => {
  assert.ok(holds('const res = await fetch(url);', 'fetch('));
  assert.ok(holds('POST /api/builds', '/api/builds'));
  assert.ok(!holds('refetch(url)', 'fetch'));
});
