/**
 * The editor skill ships as a template: no per-user profile and no personal path in it, a lookup for the user's own profiles,
 * and the README names every piece (the skills link, beats, the heavy lock, the editor), so a fresh user finds them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './script-helpers.ts';

const SKILL = path.join(ROOT, 'skills/once-upon-editor');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

test('the skill has front matter, a template and a lookup of the user profiles', () => {
  const text = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: once-upon-editor\ndescription: ".+"\n---\n/);
  assert.ok(existsSync(path.join(SKILL, 'repos/_template.md')));
  assert.ok(existsSync(path.join(SKILL, 'repos/_user-template.md')));
  assert.equal(
    text.match(/<home>\/editor\/<current directory name>\.md/g)?.length,
    1,
    'the lookup is written once',
  );
  assert.match(text, /`repos\/<current directory name>\.md` next to this file/);
});

test('nothing in the skill names a person, a personal path or a private repo', () => {
  const files = [
    'SKILL.md',
    ...readdirSync(path.join(SKILL, 'repos')).map((name) => `repos/${name}`),
  ];
  for (const rel of files) {
    const text = readFileSync(path.join(SKILL, rel), 'utf8');
    const loose =
      rel === 'repos/_user-template.md'
        ? /Configuration|ClariFi|\/Users\/|OneDrive|shank-eric|Eric/
        : /Configuration|ClariFi|\/Users\/|OneDrive|\.larmor|Larmor|shank-eric|Eric/;
    assert.doesNotMatch(text, loose, rel);
  }
  assert.deepEqual(readdirSync(path.join(SKILL, 'repos')).sort(), [
    '_template.md',
    '_user-template.md',
    'once-upon-a-diff.md',
  ]);
});

test('the README and AGENTS.md name the link script, beats, the heavy lock and the editor skill', () => {
  const readme = read('README.md');
  for (const name of [
    'scripts/link-skills.sh',
    'once-upon beat',
    'once-upon heavy',
    'once-upon-editor',
    '~/.once-upon/editor/',
  ]) {
    assert.ok(readme.includes(name), `README names ${name}`);
  }
  const agents = read('AGENTS.md');
  for (const name of ['once-upon beat', 'once-upon heavy']) {
    assert.ok(agents.includes(name), `AGENTS.md names ${name}`);
  }
  assert.doesNotMatch(agents, /~\/Configuration/);
  // every skill in skills/ is one link-skills.sh links, because it links the folder's contents
  assert.match(read('scripts/link-skills.sh'), /skills\/\*\//);
  assert.match(read('scripts/install-cli.sh'), /link-skills\.sh/);
});
