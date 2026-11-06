/** scripts/link-agents.sh: every agents/<name>.md linked as a file into CLAUDE_AGENTS_DIR, and nothing already there is replaced without --relink. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.ts';
import { ROOT, runScript } from './script-helpers.ts';

const LINK = path.join(ROOT, 'scripts/link-agents.sh');
const AGENTS = readdirSync(path.join(ROOT, 'agents')).sort();

test('it links every agent file, leaves the user own files, and a second run changes nothing', async () => {
  const dest = path.join(tmp('agents'), 'agents');
  const first = await runScript(LINK, [], { CLAUDE_AGENTS_DIR: dest });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /start a new Claude Code session/);
  assert.deepEqual(readdirSync(dest).sort(), AGENTS);
  assert.ok(AGENTS.includes('once-upon-author.md'));
  for (const name of AGENTS) {
    assert.equal(readlinkSync(path.join(dest, name)), path.join(ROOT, 'agents', name));
    assert.equal(lstatSync(path.join(dest, name)).isSymbolicLink(), true);
  }
  const again = await runScript(LINK, [], { CLAUDE_AGENTS_DIR: dest });
  assert.equal(again.stdout.match(/^ok: /gm)?.length, AGENTS.length);
  assert.doesNotMatch(again.stdout, /start a new Claude Code session/);
});

test('the folder is not replaced: the user own definitions stay where they are', async () => {
  const dest = tmp('agents');
  writeFileSync(path.join(dest, 'lookup.md'), 'mine\n');
  const run = await runScript(LINK, [], { CLAUDE_AGENTS_DIR: dest });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(readFileSync(path.join(dest, 'lookup.md'), 'utf8'), 'mine\n');
  assert.deepEqual(readdirSync(dest).sort(), ['lookup.md', ...AGENTS].sort());
});

test('a link that points elsewhere is left alone until --relink, and a real file is never replaced', async () => {
  const dest = tmp('agents');
  const elsewhere = path.join(tmp('agents-else'), 'other.md');
  writeFileSync(elsewhere, 'other\n');
  symlinkSync(elsewhere, path.join(dest, 'once-upon-author.md'));
  writeFileSync(path.join(dest, 'once-upon-critic.md'), 'mine\n');
  symlinkSync(path.join(dest, 'missing.md'), path.join(dest, 'once-upon-helper.md'));
  const run = await runScript(LINK, [], { CLAUDE_AGENTS_DIR: dest });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /left alone: .*once-upon-author\.md points to/);
  assert.match(run.stdout, /left alone: .*once-upon-helper\.md points to/);
  assert.equal(readlinkSync(path.join(dest, 'once-upon-author.md')), elsewhere);
  const relinked = await runScript(LINK, ['--relink'], { CLAUDE_AGENTS_DIR: dest });
  assert.equal(
    readlinkSync(path.join(dest, 'once-upon-author.md')),
    path.join(ROOT, 'agents/once-upon-author.md'),
  );
  assert.equal(
    readlinkSync(path.join(dest, 'once-upon-helper.md')),
    path.join(ROOT, 'agents/once-upon-helper.md'),
  );
  assert.match(relinked.stdout, /left alone: .*once-upon-critic\.md is not a link/);
  assert.equal(readFileSync(path.join(dest, 'once-upon-critic.md'), 'utf8'), 'mine\n');
});
