import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ACTIONS, AREAS } from '@once-upon-a-diff/domain/usage-actions';

const PACKAGES = path.resolve(import.meta.dirname, '../..');
/** The client code that may count an action: it runs in the browser or the extension. */
const CLIENTS = ['panel/src', 'web/public', 'extension/src', 'github-page/src'];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'vendor' || entry.name === 'node_modules' ? [] : sources(full);
    }
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

test('C9: every listed action has a call site in the client code, so a zero count means unused, not unwired', () => {
  const text = CLIENTS.flatMap((dir) => sources(path.join(PACKAGES, dir)))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const unwired = Object.keys(ACTIONS).filter((name) => !text.includes(`'${name}'`));
  assert.deepEqual(unwired, [], 'these actions are listed but nothing counts them');
});

test('a client counts only listed actions: every count(...) with a literal names one', () => {
  const found = new Set<string>();
  for (const dir of CLIENTS) {
    for (const file of sources(path.join(PACKAGES, dir))) {
      for (const match of readFileSync(file, 'utf8').matchAll(
        /\bcount\(\s*'([a-z]+\.[A-Za-z.]+)'/g,
      )) {
        found.add(match[1]);
      }
    }
  }
  assert.ok(found.size > 20, 'the scan finds the call sites');
  for (const name of found) {
    assert.ok(name in ACTIONS, `${name} is counted but not listed`);
  }
});

test('each action names one of the tool map areas', () => {
  for (const [name, action] of Object.entries(ACTIONS)) {
    assert.ok((AREAS as readonly string[]).includes(action.area), name);
  }
});
