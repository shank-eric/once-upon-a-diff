/*
 * The keys a thing is called by (a repo, a PR, a branch, a story and its state folder, the board's work keys, an agent) are
 * built in one file, packages/domain/terms/src/ids.ts. This reads every source file and fails on a line that builds one of them by
 * hand: a repo lower-cased into a `repo#N` or `repo@branch` key, a `pr:`, `story:`, `branch:` or `agent:` key, a `pr-` folder
 * name, a repo dashed into a file name, or `sid:name`. A display label (`${repo}#${number}` in a message) keeps its case and is
 * not a key, so it is not matched. A line that has to stay is listed in ALLOWED with why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCANNED = ['packages', 'skills'];
const HOME = path.join('packages', 'domain', 'terms', 'src', 'ids.ts');

const BUILDERS: [string, RegExp][] = [
  ['a lower-cased repo joined into a key', /toLowerCase\(\)\}[#@]/],
  ['a key joined and then lower-cased', /`\$\{[^}]*\}[#@]\$\{[^`]*`\.toLowerCase\(\)/],
  ['a board work key', /`(pr|story|branch|agent):/],
  ['a state folder name', /`pr-\$\{/],
  ['a repo dashed into a name', /\.replace\('\/', '-'\)|\.replace\(\/\\\/\/g, '-'\)/],
  ['an agent id', /\$\{[^}]*sid8?[^}]*\}:\$\{/],
];

/** `<file> :: <line>` for a line that is a key builder and is allowed to stay, with why. */
const ALLOWED: Record<string, string> = {
  // a folder name for a git worktree, not a key
  "packages/domain/test-kit/src/git.ts :: const add = (branch: string, folder = branch.replace(/\\//g, '-')) => {":
    'a test helper names a worktree folder after a branch',
};

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'test', '.output', 'dist', 'public-build'].includes(entry.name)
        ? []
        : sources(full);
    }
    return /\.(ts|mjs)$/.test(entry.name) ? [full] : [];
  });

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

test('every key is built in terms/src/ids.ts, nowhere else', () => {
  for (const folder of SCANNED) {
    assert.ok(existsSync(path.join(ROOT, folder)), `${folder} must exist`);
  }
  const found: string[] = [];
  for (const folder of SCANNED) {
    for (const file of sources(path.join(ROOT, folder))) {
      const rel = path.relative(ROOT, file);
      if (rel === HOME) {
        continue;
      }
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line) => {
          if (!isComment(line) && BUILDERS.some(([, pattern]) => pattern.test(line))) {
            found.push(`${rel} :: ${line.trim()}`);
          }
        });
    }
  }
  assert.deepEqual(
    found.filter((entry) => !(entry in ALLOWED)),
    [],
    'build the key with a function from packages/domain/terms/src/ids.ts',
  );
  for (const entry of Object.keys(ALLOWED)) {
    assert.ok(found.includes(entry), `ALLOWED has an entry nothing matches any more: ${entry}`);
  }
});

test('the module exists, so the scan has a home to skip', () => {
  assert.ok(existsSync(path.join(ROOT, HOME)));
});
