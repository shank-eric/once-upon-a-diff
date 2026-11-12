/*
 * No path climbs out of one package into another (Eric, 11/12: "I want to avoid any paths that have to go up and over to other
 * packages"): a `../` string in a file under packages/ or scripts/ whose target is in a different package reaches that package
 * by its name instead (an `exports` entry plus a normal import or `import.meta.resolve('@once-upon-a-diff/<pkg>/<path>')`, a
 * `yarn workspace @once-upon-a-diff/<pkg> <script>` in a package.json script, the root configs/ for a tsconfig). A path that
 * truly cannot be a name goes in configs/cross-package-paths.allow.json with its reason. Root files (configs/, the repo-root
 * tsconfigs) belong to no package and may point down into one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../../../..');
const SKIP_DIRS = new Set(['node_modules', '.output', '.wxt', 'test-results', 'vendor']);
const CODE = /\.(?:ts|mts|mjs|cjs|js|json|jsonc|sh|css|html)$/;
/**
 * A `../` chain after a quote, a space, an open paren, a `./` or a template expression (`${import.meta.dirname}/../x`): a path
 * string, or one inside a script line or a CSS `@import`. '/api/a/../b' has it after a name and a slash and is no path of the file.
 */
const PATH_STRING = /(?<=['"`\s(]|\}\/)(?:\.\/)*((?:\.\.\/)+[^'"`\s$)]*)/g;
/** Two or more string arguments in a row (a path.join of segments, one of them `..`): the segments of one path. */
const SEGMENT_RUN = /['"`][^'"`\n]*['"`](?:\s*,\s*['"`][^'"`\n]*['"`])+/g;

/** The paths a file spells: its `../` strings, and each run of string arguments that starts with `..` joined into one. */
function pathLiterals(text: string): string[] {
  const literals = [...text.matchAll(PATH_STRING)].map((one) => one[1]);
  for (const [run] of text.matchAll(SEGMENT_RUN)) {
    const parts = [...run.matchAll(/['"`]([^'"`\n]*)['"`]/g)].map((one) => one[1]);
    const first = parts.findIndex((part) => part === '..' || part.startsWith('../'));
    if (first >= 0) {
      literals.push(parts.slice(first).join('/'));
    }
  }
  return literals;
}

/** The package a repo-relative path is in (`packages/<group>/<name>`), or null for a root file or the folders between. */
const packageOf = (file: string) => /^(packages\/[^/]+\/[^/]+)\//.exec(`${file}/`)?.[1] ?? null;

/** The `../` strings in `text`, a file of the repo at `file`, whose target is in a package other than the file's own. */
export function crossPackagePaths(file: string, text: string): string[] {
  const own = packageOf(file);
  const out: string[] = [];
  for (const literal of pathLiterals(text)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), literal));
    if (target.startsWith('packages/') && packageOf(target) !== own) {
      out.push(literal);
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(rel);
    }
    return CODE.test(entry.name) ? [rel] : [];
  });
}

const ALLOWED: { file: string; literal: string; reason: string }[] = JSON.parse(
  readFileSync(path.join(REPO, 'configs/cross-package-paths.allow.json'), 'utf8'),
);

test('no file under packages/ or scripts/ has a ../ path into another package, outside the allow-list', () => {
  const used = new Set<number>();
  const found: string[] = [];
  for (const file of [...sourceFiles('packages'), ...sourceFiles('scripts')]) {
    for (const literal of crossPackagePaths(file, readFileSync(path.join(REPO, file), 'utf8'))) {
      const slot = ALLOWED.findIndex((one) => one.file === file && one.literal === literal);
      if (slot < 0) {
        found.push(`${file}: ${literal}`);
      } else {
        used.add(slot);
      }
    }
  }
  assert.deepEqual(
    found,
    [],
    'reach the other package by its name, or list the path in configs/cross-package-paths.allow.json with its reason',
  );
  assert.deepEqual(
    ALLOWED.filter((_, slot) => !used.has(slot)).map((one) => `${one.file}: ${one.literal}`),
    [],
    'an allow-list entry no file uses any more',
  );
  for (const one of ALLOWED) {
    assert.ok(one.reason.length > 20, `${one.file}: say why it cannot be a name`);
  }
});

test('the scan sees a path into another package, in code, a test, a tsconfig and a script, and not one that stays inside', () => {
  const climb = (count: number, rest: string) => [...Array(count).fill('..'), rest].join('/');
  const into = (file: string, literal: string) => crossPackagePaths(file, `x('${literal}')`);
  assert.equal(into('packages/client/web/test/a.ts', climb(3, 'domain/terms/src/x.ts')).length, 1);
  assert.equal(
    into('packages/client/extension/wxt.config.ts', climb(1, 'panel/src/css/page.css')).length,
    1,
  );
  assert.equal(into('packages/server/bridge/test/a.ts', climb(3, 'client/web/public/')).length, 1);
  assert.equal(
    crossPackagePaths(
      'packages/a/b/package.json',
      `"node ${climb(2, 'server-libs/foundation/x.mjs')}"`,
    ).length,
    1,
  );
  assert.equal(into('scripts/x.sh', climb(1, 'packages/client/web/x.ts')).length, 1);
  assert.equal(
    crossPackagePaths(
      'packages/client/web/test/a.ts',
      `new URL("${climb(1, 'public/')}", import.meta.url)`,
    ).length,
    0,
  );
  assert.equal(
    into('packages/client/web/public/tsconfig.json', climb(4, 'configs/tsconfig.base.json')).length,
    0,
  );
  assert.equal(into('packages/client/web/test/a.ts', '/api/stories/a/../../health').length, 0);
  const here = 'packages/server/bridge/test/a.ts';
  const climbed = climb(3, 'client/web/public');
  const quoted = (...parts: string[]) => parts.map((part) => `'${part}'`).join(', ');
  // the forms a plain `'../' string` scan misses: a template expression, string arguments, a leading `./`
  assert.equal(crossPackagePaths(here, 'x(`${import.meta.dirname}/' + climbed + '`)').length, 1);
  assert.equal(
    crossPackagePaths(
      here,
      `path.resolve(import.meta.dirname, ${quoted(climb(2, '..'), 'client/web/public')})`,
    ).length,
    1,
  );
  assert.equal(
    crossPackagePaths(
      here,
      `path.join(import.meta.dirname, ${quoted(...Array(3).fill('..'), 'client', 'web')})`,
    ).length,
    1,
  );
  assert.equal(into(here, `./${climbed}`).length, 1);
  assert.equal(
    crossPackagePaths(
      'packages/client/panel/src/css/a.css',
      `@import '${climb(3, 'client-libs/ui-kit/src/css/tokens.css')}';`,
    ).length,
    1,
  );
  assert.equal(
    crossPackagePaths(
      here,
      `path.join(import.meta.dirname, ${quoted('..', 'bin', 'once-upon.mjs')})`,
    ).length,
    0,
  );
});
