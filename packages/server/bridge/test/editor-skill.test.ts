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
    'scripts/link-agents.sh',
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
  assert.match(read('scripts/install-cli.sh'), /link-agents\.sh/);
  assert.match(read('scripts/install-cli.sh'), /--no-agents/);
  assert.match(read('scripts/link-agents.sh'), /agents\/\*\.md/);
});

test('the editor skill launches each role by its type and keeps the general-purpose fallback and the per-call effort', () => {
  const text = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(text, /`general-purpose`/);
  assert.match(text, /Pass effort on every Agent call/);
  assert.match(text, /`scripts\/link-agents\.sh`/);
  assert.match(text, /`once-upon-author` \(authors and fixers\)/);
  assert.match(text, /`once-upon-helper` agent \(effort medium\)/);
  assert.doesNotMatch(text, /`lookup`|`backlog-clerk`|`research`|clerk/);
});

test('the lean-types bullet sends a relaying role and a self-telling author to general-purpose', () => {
  const text = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(
    text,
    /relay session is on, a role whose brief carries the forwarding line launches as `general-purpose` at the same effort, because the lean types have no SendMessage/,
  );
  assert.match(
    text,
    /tells its own story launches its authors as `general-purpose`, because `once-upon-author` has no once-upon skill/,
  );
});

test('every deploy command the skill writes starts with a program, not a VAR=value word (once-upon deploy runs no shell)', () => {
  let seen = 0;
  for (const rel of ['SKILL.md', 'repos/_template.md', 'repos/once-upon-a-diff.md']) {
    const text = readFileSync(path.join(SKILL, rel), 'utf8');
    for (const match of text.matchAll(/once-upon deploy (\S+) (\S+)/g)) {
      seen += 1;
      assert.doesNotMatch(match[2], /^[A-Za-z_]\w*=/, `${rel}: ${match[0]}`);
    }
  }
  const profile = readFileSync(path.join(SKILL, 'repos/once-upon-a-diff.md'), 'utf8');
  assert.match(profile, /once-upon deploy <name> scripts\/deploy-local\.sh --yes <branch>/);
  assert.ok(seen >= 3, 'the skill, the template and the profile each write one');
});

test('the claim/start ordering is dispatch’s: the skill and AGENTS.md "Backlog cards" point at dispatch and handback, not the by-hand rules', () => {
  const skill = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const agents = read('AGENTS.md');
  const cards = agents.slice(
    agents.indexOf('## Backlog cards'),
    agents.indexOf('## The live bridge'),
  );
  for (const [where, text] of [
    ['SKILL.md', skill],
    ['AGENTS.md Backlog cards', cards],
  ] as const) {
    assert.match(text, /once-upon dispatch/, `${where} names dispatch`);
    assert.match(text, /once-upon handback/, `${where} names handback`);
    assert.ok(!/claim the card before/i.test(text), `${where}: no claim-before-start rule by hand`);
    assert.ok(!text.includes('an author started on a card with no claim is refused'), where);
  }
  // (AGENTS.md keeps the line for an author that takes a card itself, with no editor)
  assert.ok(!skill.includes('backlog claim <id> --agent'), 'the skill types no claim');
  // the repo profiles no longer carry the lines the editor typed the commands from
  for (const rel of ['repos/_template.md', 'repos/once-upon-a-diff.md']) {
    const text = readFileSync(path.join(SKILL, rel), 'utf8');
    assert.doesNotMatch(text, /^- (Claim|Agent command)/m, rel);
  }
  // what a brief used to carry by hand is in the generated brief and the agent types
  assert.doesNotMatch(skill, /Every brief carries the beat line/);
  assert.match(skill, /brief-extra\.md/);
});

test('the cleanup helper is started by hand: a landed card refuses every run, so dispatch cannot launch it', () => {
  const skill = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /dispatch <card> --role helper --name cleanup-/);
  assert.match(skill, /agent start cleanup-<branch>/);
});

test('the skill says a general-purpose launch asks dispatch for it (--general), which carries the standing rules', () => {
  const skill = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(skill, /--general/);
  assert.doesNotMatch(skill, /are in the agent types, not in each brief/);
});
