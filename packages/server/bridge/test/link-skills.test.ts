/** scripts/link-skills.sh: every skills/<name> linked into CLAUDE_SKILLS_DIR, and nothing already there is replaced without --relink. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.ts';
import { ROOT, runScript } from './script-helpers.ts';

const LINK = path.join(ROOT, 'scripts/link-skills.sh');
const SKILLS = readdirSync(path.join(ROOT, 'skills')).sort();

test('it links every skill, including the editor, and a second run changes nothing', async () => {
  const dest = path.join(tmp('skills'), 'skills');
  const first = await runScript(LINK, [], { CLAUDE_SKILLS_DIR: dest });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(readdirSync(dest).sort(), SKILLS);
  assert.ok(SKILLS.includes('once-upon-editor'));
  for (const name of SKILLS) {
    assert.equal(readlinkSync(path.join(dest, name)), path.join(ROOT, 'skills', name));
  }
  const again = await runScript(LINK, [], { CLAUDE_SKILLS_DIR: dest });
  assert.equal(again.stdout.match(/^ok: /gm)?.length, SKILLS.length);
});

test('a link that points elsewhere is left alone until --relink, and a real folder is never replaced', async () => {
  const dest = tmp('skills');
  const elsewhere = tmp('skills-else');
  symlinkSync(elsewhere, path.join(dest, 'once-upon-editor'));
  mkdirSync(path.join(dest, 'once-upon'));
  const run = await runScript(LINK, [], { CLAUDE_SKILLS_DIR: dest });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /left alone: .*once-upon-editor points to/);
  assert.equal(readlinkSync(path.join(dest, 'once-upon-editor')), elsewhere);
  const relinked = await runScript(LINK, ['--relink'], { CLAUDE_SKILLS_DIR: dest });
  assert.equal(
    readlinkSync(path.join(dest, 'once-upon-editor')),
    path.join(ROOT, 'skills/once-upon-editor'),
  );
  assert.match(relinked.stdout, /left alone: .*once-upon is not a link/);
  assert.equal(lstatSync(path.join(dest, 'once-upon')).isDirectory(), true);
});
