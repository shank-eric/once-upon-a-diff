import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmp } from './helpers.ts';
import {
  copyFileAtomic,
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
} from '../src/util/json-file.ts';
import { loadConfig } from '../src/config/settings.ts';
import { runGh } from '../src/util/gh.ts';
import { parseUnifiedDiff } from '../src/util/diff.ts';

test('JSON files: a fallback for a missing or broken file, pretty output, no temp file left', () => {
  const dir = tmp('json-file');
  const file = path.join(dir, 'state.json');
  assert.deepEqual(readJson(file, { empty: true }), { empty: true });
  writeFileSync(file, '{not json');
  assert.equal(readJson(file), null);
  writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(readJson(file), { a: 1 });
  writeJsonAtomic(file, { b: [1, 2] });
  assert.deepEqual(readJson(file), { b: [1, 2] });
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('atomic writes: the mode holds, a failed write leaves no temp file', () => {
  const dir = tmp('json-atomic');
  const secret = path.join(dir, 'config.json');
  writeFileAtomic(secret, '{}', 0o600);
  assert.equal(statSync(secret).mode & 0o777, 0o600);
  writeJsonAtomic(secret, { k: 1 }); // no mode given: the file keeps its own
  assert.equal(statSync(secret).mode & 0o777, 0o600);
  assert.throws(() => writeJsonAtomic(path.join(dir, 'missing', 'x.json'), {}));
  assert.deepEqual(readdirSync(dir), ['config.json']);
});

test('atomic writes: two writers at once both leave valid JSON, never a partial file', async () => {
  const dir = tmp('json-race');
  const file = path.join(dir, 'shared.json');
  const mod = new URL('../src/util/json-file.ts', import.meta.url).href;
  const script = `
    import { writeJsonAtomic } from ${JSON.stringify(mod)};
    const [file, tag] = process.argv.slice(1);
    const pad = 'x'.repeat(200000);
    for (let i = 0; i < 150; i += 1) writeJsonAtomic(file, { tag, i, pad });
  `;
  writeJsonAtomic(file, { tag: 'seed', i: 0, pad: 'x' });
  const writers = ['a', 'b'].map(
    (tag) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, tag], {
          stdio: 'ignore',
        });
        child.on('close', resolve);
      }),
  );
  // read the whole time the writers run: every read must parse
  let reads = 0; // reads of a file a writer made, not the seed
  let torn: unknown = null;
  let racing = true;
  const reader = (async () => {
    while (racing) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { tag: string };
        reads += parsed.tag === 'seed' ? 0 : 1;
      } catch (err) {
        torn = err;
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  const codes = await Promise.all(writers);
  racing = false;
  await reader;
  assert.equal(torn, null, 'a read saw a partial file');
  assert.deepEqual(codes, [0, 0]);
  assert.ok(reads > 0, 'the reader never overlapped a writer');
  const last = readJson<{ tag: string; i: number }>(file)!;
  assert.ok(['a', 'b'].includes(last.tag));
  assert.deepEqual(readdirSync(dir), ['shared.json']);
});

test('copyFileAtomic: the copy lands whole and leaves no temp file', () => {
  const dir = tmp('copy-atomic');
  writeFileSync(path.join(dir, 'a.json'), '{"a":1}');
  writeFileSync(path.join(dir, 'b.json'), 'old');
  copyFileAtomic(path.join(dir, 'a.json'), path.join(dir, 'b.json'));
  assert.equal(readFileSync(path.join(dir, 'b.json'), 'utf8'), '{"a":1}');
  assert.throws(() => copyFileAtomic(path.join(dir, 'nope.json'), path.join(dir, 'b.json')));
  assert.deepEqual(readdirSync(dir).sort(), ['a.json', 'b.json']);
});

test('loadConfig: an empty or unparseable config.json is kept as a copy before a fresh one is made', () => {
  const home = tmp('config-bad');
  const file = path.join(home, 'config.json');
  const errors: string[] = [];
  const was = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    writeFileSync(file, '{"ship":{"a/b":"pr"},');
    const cfg = loadConfig(home);
    assert.ok(cfg.token && cfg.port);
    const kept = readdirSync(home).filter((name) => name.startsWith('config.json.unreadable-'));
    assert.equal(kept.length, 1);
    assert.equal(readFileSync(path.join(home, kept[0]), 'utf8'), '{"ship":{"a/b":"pr"},');
    assert.match(errors.join('\n'), /not JSON/);
    assert.equal(readJson<{ token: string }>(file)!.token, cfg.token);
    errors.length = 0;
    loadConfig(home); // a good file is left alone, quietly
    assert.deepEqual(errors, []);
    assert.equal(readdirSync(home).filter((name) => name.includes('unreadable')).length, 1);
  } finally {
    console.error = was;
  }
});

test('runGh: stdout on success, the first line of stderr on failure', async () => {
  const was = process.env.ONCE_UPON_GH;
  try {
    process.env.ONCE_UPON_GH = '/bin/echo';
    assert.equal((await runGh(['api', 'user'])).trim(), 'api user');
    process.env.ONCE_UPON_GH = '/bin/sh';
    await assert.rejects(
      runGh(['-c', 'echo first >&2; echo second >&2; exit 1']),
      /^Error: first$/,
    );
  } finally {
    if (was === undefined) {
      delete process.env.ONCE_UPON_GH;
    } else {
      process.env.ONCE_UPON_GH = was;
    }
  }
});

test('parses a unified diff', () => {
  const diff = parseUnifiedDiff(
    [
      'diff --git a/x.js b/x.js',
      'index 1..2 100644',
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,2 +1,3 @@ fn()',
      ' a',
      '-b',
      '+B',
      '+c',
      'diff --git a/old.js b/new.js',
      'similarity index 90%',
      'rename from old.js',
      'rename to new.js',
    ].join('\n'),
  );
  const file = diff.get('x.js')!;
  assert.deepEqual(file.stats, { added: 2, removed: 1 });
  assert.equal(file.hunks[0].header, 'fn()');
  assert.equal(diff.get('new.js')!.kind, 'renamed');
  assert.equal(diff.get('new.js')!.renamed_from, 'old.js');
  assert.notEqual(file.hash, diff.get('new.js')!.hash);
});
