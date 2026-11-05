/*
 * Probes for the package and tier rules in configs/.dependency-cruiser.mjs. A temp tree shaped like packages/core/src/<tier>/<folder>,
 * packages/server/src, packages/cli/src and packages/bridge/bin holds one file per probe; the repo's config runs over it, and each probe
 * must trip its rule and nothing else does. A rule whose path stops matching (a renamed tier, a moved package) goes quiet and fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@once-upon-a-diff/test-kit/files';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEPCRUISE = path.join(ROOT, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const CONFIG = path.join(ROOT, 'configs/.dependency-cruiser.mjs');

// folders that exist in the tree, each with a `leaf.ts` for the probes to import
const FOLDERS = [
  'core/src/adapters',
  'core/src/foundation',
  'core/src/records/stories',
  'core/src/records/agents',
  'core/src/queues/requests',
  'core/src/queues/backlog',
  'core/src/features/review',
  'core/src/features/sessions',
  'core/src/orchestration/board',
  'core/src/orchestration/bridge',
  'server/src',
  'cli/src',
  'bridge/bin',
];

// [probe file, the leaf folder it imports, the rule(s) that must fire (null: it is allowed)]
const PROBES: [string, string, string | string[] | null][] = [
  ['core/src/foundation/up.ts', 'core/src/records/stories', 'core-foundation-below'],
  ['core/src/records/stories/up.ts', 'core/src/queues/requests', 'core-records-below'],
  ['core/src/queues/requests/up.ts', 'core/src/features/review', 'core-queues-below'],
  ['core/src/features/review/up.ts', 'core/src/orchestration/board', 'core-features-below'],
  ['core/src/records/stories/side.ts', 'core/src/records/agents', 'core-tier-siblings-apart'],
  ['core/src/queues/requests/side.ts', 'core/src/queues/backlog', 'core-tier-siblings-apart'],
  ['core/src/features/review/side.ts', 'core/src/features/sessions', 'core-tier-siblings-apart'],
  [
    'core/src/orchestration/board/side.ts',
    'core/src/orchestration/bridge',
    'core-tier-siblings-apart',
  ],
  ['core/src/adapters/up.ts', 'core/src/records/stories', 'adapters-are-bottom'],
  // an adapter importing an app breaks both rules
  ['core/src/adapters/app.ts', 'server/src', ['adapters-are-bottom', 'core-below-apps']],
  ['core/src/orchestration/bridge/app.ts', 'cli/src', 'core-below-apps'],
  ['core/src/records/agents/shell.ts', 'bridge/bin', 'core-below-apps'],
  ['server/src/adapter.ts', 'core/src/adapters', 'apps-use-core-not-adapters'],
  ['cli/src/adapter.ts', 'core/src/adapters', 'apps-use-core-not-adapters'],
  ['server/src/cli.ts', 'cli/src', 'http-cli-apart'],
  ['cli/src/server.ts', 'server/src', 'cli-not-http'],
  ['server/src/shell.ts', 'bridge/bin', 'apps-not-the-shell'],
  ['cli/src/shell.ts', 'bridge/bin', 'apps-not-the-shell'],
  // allowed: down a tier, into adapters, an app into a tier, the shell into everything
  ['core/src/records/stories/ok-down.ts', 'core/src/foundation', null],
  ['core/src/records/stories/ok-adapter.ts', 'core/src/adapters', null],
  ['core/src/orchestration/board/ok-down.ts', 'core/src/records/stories', null],
  ['core/src/orchestration/bridge/ok-down.ts', 'core/src/queues/backlog', null],
  ['server/src/ok-tier.ts', 'core/src/records/stories', null],
  ['cli/src/ok-tier.ts', 'core/src/orchestration/board', null],
  ['bridge/bin/ok-apps.ts', 'server/src', null],
  ['bridge/bin/ok-cli.ts', 'cli/src', null],
];

test('each package and tier rule fires on its probe, and on nothing else', async () => {
  const dir = tmp('layer-rules');
  const packages = path.join(dir, 'packages');
  for (const folder of FOLDERS) {
    mkdirSync(path.join(packages, folder), { recursive: true });
    writeFileSync(path.join(packages, folder, 'leaf.ts'), 'export const leaf = 1;\n');
  }
  for (const [file, target] of PROBES) {
    const from = path.join(packages, path.dirname(file));
    const rel = path
      .relative(from, path.join(packages, target, 'leaf.ts'))
      .split(path.sep)
      .join('/');
    writeFileSync(
      path.join(packages, file),
      `import { leaf } from '${rel.startsWith('.') ? rel : `./${rel}`}';\nexport const used = leaf;\n`,
    );
  }
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      process.execPath,
      [DEPCRUISE, '--config', CONFIG, '--output-type', 'json', 'packages'],
      { cwd: dir, maxBuffer: 1 << 26 },
      (_err, out) => resolve(out),
    );
  });
  const violations = (
    JSON.parse(stdout) as { summary: { violations: { from: string; rule: { name: string } }[] } }
  ).summary.violations;
  const found = violations.map((one) => `${one.from} ${one.rule.name}`).sort();
  const expected = PROBES.flatMap(([file, , rule]) =>
    [rule ?? []].flat().map((name) => `packages/${file} ${name}`),
  ).sort();
  assert.deepEqual(found, expected);
});
