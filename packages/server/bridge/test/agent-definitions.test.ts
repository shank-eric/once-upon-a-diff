/**
 * The agent definitions in agents/: each is a flat front matter plus a short body, names the tools it needs and nothing more,
 * carries no person, personal path or private repo, and the editor skill names exactly these types.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './script-helpers.ts';

const DIR = path.join(ROOT, 'agents');
const FILES = readdirSync(DIR).sort();
// SendMessage is deliberately absent: whether `tools:` alone loads a deferred tool is untested (see the card's notes).
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'];
const EXPECTED = [
  'once-upon-author',
  'once-upon-clerk',
  'once-upon-critic',
  'once-upon-helper',
  'once-upon-storyteller',
];

type Definition = { fields: Map<string, string>; body: string };

/** Front matter is flat `key: value` lines (a value may be double-quoted); anything else is an error, so it is valid YAML. */
function parse(file: string): Definition {
  const text = readFileSync(path.join(DIR, file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${file} has front matter`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split('\n')) {
    const field = /^([a-zA-Z]+): (.+)$/.exec(line);
    assert.ok(field, `${file}: "${line}" is a key: value line`);
    const [, key, value] = field;
    assert.ok(!fields.has(key!), `${file}: ${key} appears once`);
    const quoted = /^"(.*)"$/.exec(value!);
    if (!quoted && /: |^[[{&*!|>'%@`#]| #/.test(value!)) {
      assert.fail(`${file}: ${key} needs quotes`);
    }
    fields.set(key!, quoted ? quoted[1]! : value!);
  }
  return { fields, body: match[2]! };
}

const tools = (def: Definition) => def.fields.get('tools')!.split(', ');

test('the folder holds exactly the five once-upon agents', () => {
  assert.deepEqual(
    FILES,
    EXPECTED.map((name) => `${name}.md`),
  );
});

test('each definition has a name equal to its file, a one-sentence description, tools, a model and a short body', () => {
  for (const file of FILES) {
    const name = file.replace(/\.md$/, '');
    const def = parse(file);
    assert.equal(def.fields.get('name'), name, file);
    assert.match(name, /^once-upon-/);
    const description = def.fields.get('description');
    assert.ok(description && description.length < 200, `${file} has a short description`);
    assert.match(description, /^[^.]+\.$/, `${file}: one sentence`);
    assert.ok(def.fields.get('tools'), `${file} has tools`);
    assert.match(def.fields.get('model') ?? '', /^(sonnet|opus|haiku)$/, file);
    assert.equal(def.fields.has('effort'), false, `${file}: effort comes from the call`);
    assert.ok(def.body.split(/\s+/).filter(Boolean).length <= 140, `${file}: body stays short`);
  }
});

test('tools are known, Skill is never listed, and the roles hold the tools they need and no more', () => {
  const toolsOf = (name: string) => tools(parse(`${name}.md`));
  for (const file of FILES) {
    for (const tool of tools(parse(file))) {
      assert.ok(ALLOWED_TOOLS.includes(tool), `${file}: ${tool} is an allowed tool`);
    }
  }
  assert.ok(toolsOf('once-upon-author').includes('Edit'));
  assert.ok(toolsOf('once-upon-storyteller').includes('Write'));
  for (const name of ['once-upon-critic', 'once-upon-helper', 'once-upon-clerk']) {
    assert.ok(!toolsOf(name).includes('Edit'), `${name} has no Edit`);
  }
  assert.ok(
    toolsOf('once-upon-critic').includes('Write') && toolsOf('once-upon-critic').includes('Bash'),
  );
  assert.deepEqual(toolsOf('once-upon-clerk'), ['Bash']);
  assert.equal(parse('once-upon-critic.md').fields.get('model'), 'opus');
});

test('skills named in a definition are folders in skills/, and only the storyteller preloads one', () => {
  for (const file of FILES) {
    const skills = parse(file).fields.get('skills');
    if (skills === undefined) {
      continue;
    }
    assert.equal(file, 'once-upon-storyteller.md');
    for (const skill of skills.split(', ')) {
      assert.ok(existsSync(path.join(ROOT, 'skills', skill, 'SKILL.md')), `skill ${skill}`);
    }
  }
  assert.equal(parse('once-upon-storyteller.md').fields.get('skills'), 'once-upon');
});

test('no body names a person, a personal path or a private repo, and each says what never to do', () => {
  for (const file of FILES) {
    const text = readFileSync(path.join(DIR, file), 'utf8');
    assert.doesNotMatch(
      text,
      /Configuration|ClariFi|\/Users\/|OneDrive|\.larmor|Larmor|shank-eric|Eric/,
      file,
    );
    assert.match(parse(file).body, /3 short lines/, `${file}: short report`);
    assert.match(parse(file).body, /never [^.]*push/i, `${file}: no push`);
  }
});

test('the editor skill names every type that exists, and only those', () => {
  const skill = readFileSync(path.join(ROOT, 'skills/once-upon-editor/SKILL.md'), 'utf8');
  const named = new Set(skill.match(/once-upon-(?:author|critic|storyteller|helper|clerk)\b/g));
  assert.deepEqual([...named].sort(), EXPECTED);
  for (const name of skill.match(/`once-upon-[a-z]+`/g) ?? []) {
    const bare = name.slice(1, -1);
    if (bare === 'once-upon-editor' || bare === 'once-upon-listen') {
      continue;
    }
    assert.ok(EXPECTED.includes(bare), `${bare} exists in agents/`);
  }
});
