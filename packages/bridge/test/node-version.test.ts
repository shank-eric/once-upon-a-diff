import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIN_NODE_MAJOR, nodeVersionProblem } from '../bin/node-version.mjs';

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Node older than 24 gets one line naming the version, the binary and the fix', () => {
  assert.equal(MIN_NODE_MAJOR, 24);
  for (const old of ['20.19.0', 'v20.19.0', '22.18.0', '23.6.0', '18.0.0']) {
    const problem = nodeVersionProblem(old, '/usr/local/bin/node');
    assert.ok(problem, `${old} is too old`);
    assert.match(
      problem,
      /^Once Upon a Diff needs Node 24 or newer \(found v\d+\.\d+\.\d+ at \/usr\/local\/bin\/node\)\./,
    );
    assert.match(problem, /fnm use/);
    assert.match(problem, /nvm use/);
    assert.match(problem, /fnm exec --using=24/);
    assert.doesNotMatch(problem, /\n/, 'one line');
  }
  assert.match(nodeVersionProblem('v20.19.0') as string, /found v20\.19\.0 at /, 'no doubled v');
});

test('Node 24 and newer pass, and so does the Node running the tests', () => {
  for (const ok of ['24.0.0', '24.14.0', '25.1.0', 'v26.0.0']) {
    assert.equal(nodeVersionProblem(ok), null, ok);
  }
  assert.equal(nodeVersionProblem(), null);
  assert.ok(Number(process.versions.node.split('.')[0]) >= MIN_NODE_MAJOR);
});

test('every package script that runs TypeScript with node checks the version first', () => {
  for (const pkg of readdirSync(PACKAGES)) {
    const { scripts = {}, bin = {} } = JSON.parse(
      readFileSync(path.join(PACKAGES, pkg, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string>; bin?: Record<string, string> };
    for (const entry of Object.values(bin)) {
      assert.match(entry, /\.mjs$/, `${pkg}'s bin is the plain-JS entry`);
    }
    for (const [name, script] of Object.entries(scripts)) {
      const runsTs = /\bnode (--test )?\S*\.ts\b/.test(script) || /\bnode --test\b/.test(script);
      const runsGuardedEntry = /^node bin\/once-upon\.mjs\b/.test(script);
      if (!runsTs || runsGuardedEntry) {
        continue;
      }
      assert.match(
        script,
        /^node (\.\.\/bridge\/)?bin\/node-version\.mjs && /,
        `${pkg} ${name} checks the Node version before it runs TypeScript`,
      );
    }
  }
});
